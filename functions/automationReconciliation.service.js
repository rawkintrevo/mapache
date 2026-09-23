"use strict";

const logger = require("firebase-functions/logger");
const {admin: defaultAdmin, auth: defaultAuth, db: defaultDb} = require("./backendContext");
const {
  DEFAULT_REGION,
  DEFAULT_CLOUD_RUN_OPERATION_TIMEOUT_MS,
} = require("./backendConfig");
const {
  cloudRunServiceName,
  isGoogleNotFound,
} = require("./backendUtils.helpers");
const {
  automationCloudRunServiceId,
} = require("./provisioning.helpers");
const {automationSessionId} = require("./runtimePaths.helpers");
const {cloudRunServiceLabels, waitForCloudRunServiceDeleted, waitForOperation} = require("./cloudRun.service");
const {isTerminalAutomationStatus} = require("./automationState.helpers");

const PAGE_SIZE = 50;
const MAX_RUN_PAGES = 5;
const MAX_SERVICE_PAGES = 5;
const DEFAULT_HEARTBEAT_MAX_AGE_MS = 3 * 60 * 1000;
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 5 * 1000;
const ACTIVE_RUN_STATUSES = ["provisioning", "running", "stopping"];
const RECONCILIATION_RUN_STATUSES = [
  ...ACTIVE_RUN_STATUSES,
  "succeeded", "failed", "canceled", "interrupted",
];

function createAutomationReconciliationService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    auth: dependencies.auth || defaultAuth,
    cleanupAutomationRun: dependencies.cleanupAutomationRun,
    db: dependencies.db || defaultDb,
    deleteCloudRunService: dependencies.deleteCloudRunService,
    featureEnabled: dependencies.featureEnabled,
    getCloudRunService: dependencies.getCloudRunService,
    heartbeatMaxAgeMs: positiveNumber(dependencies.heartbeatMaxAgeMs, DEFAULT_HEARTBEAT_MAX_AGE_MS),
    healthProbe: dependencies.healthProbe,
    healthProbeTimeoutMs: positiveNumber(dependencies.healthProbeTimeoutMs, DEFAULT_HEALTH_PROBE_TIMEOUT_MS),
    listCloudRunServices: dependencies.listCloudRunServices,
    listRuns: dependencies.listRuns,
    now: dependencies.now || (() => Date.now()),
    provisionAutomationRun: dependencies.provisionAutomationRun,
    processDueRetries: dependencies.processDueRetries,
    requestRunnerJson: dependencies.requestRunnerJson,
    sessionCollection: dependencies.sessionCollection,
  };
  if (typeof shared.cleanupAutomationRun !== "function") {
    throw new Error("Automation reconciliation requires a cleanupAutomationRun dependency.");
  }
  if (typeof shared.sessionCollection !== "function") {
    throw new Error("Automation reconciliation requires a sessionCollection dependency.");
  }
  return {
    reconcile: () => reconcile(shared),
  };
}

async function reconcile(dependencies = {}) {
  if (typeof dependencies.featureEnabled === "function" && !(await dependencies.featureEnabled())) {
    return {skipped: "disabled", runs: 0, services: 0};
  }

  const runs = await listActiveRuns(dependencies);
  const result = {
    checkedRuns: runs.length,
    healthy: 0,
    resumedProvisioning: 0,
    resumedCleanup: 0,
    interrupted: 0,
    retained: 0,
    orphanServices: 0,
    orphanDeleted: 0,
    errors: 0,
    retries: {checked: 0, enqueued: 0, deferred: 0, canceled: 0, errors: 0},
  };
  if (typeof dependencies.processDueRetries === "function") {
    result.retries = await dependencies.processDueRetries();
  }
  const liveAutomationLabels = new Set();

  for (const run of runs) {
    const label = cloudRunServiceLabels({
      automationRunId: run.runId,
      ownerUid: run.ownerUid,
      runtimeKind: "automation",
      workspaceId: run.workspaceId,
    })["mapache-automation-run"];
    if (label && runNeedsRuntime(run)) liveAutomationLabels.add(label);

    try {
      const action = await reconcileRun(run, dependencies);
      if (action === "healthy") result.healthy += 1;
      else if (action === "provisioning") result.resumedProvisioning += 1;
      else if (action === "cleanup") result.resumedCleanup += 1;
      else if (action === "interrupted") result.interrupted += 1;
      else if (action === "retained") result.retained += 1;
    } catch (error) {
      result.errors += 1;
      logger.warn("automation run reconciliation failed", {
        runId: run.runId,
        code: stableReconciliationErrorCode(error),
      });
    }
  }

  const orphanResult = await reconcileOrphanServices(liveAutomationLabels, dependencies);
  result.orphanServices = orphanResult.checked;
  result.orphanDeleted = orphanResult.deleted;
  result.errors += orphanResult.errors;
  return result;
}

async function reconcileRun(run, dependencies = {}) {
  const status = normalize(run.status);
  if (status === "provisioning") {
    if (typeof dependencies.provisionAutomationRun !== "function") return "retained";
    await dependencies.provisionAutomationRun(run.runId);
    return "provisioning";
  }
  if (status === "stopping" || (isTerminalAutomationStatus(status) && normalize(run.cleanupState) !== "complete")) {
    await dependencies.cleanupAutomationRun(run.runId);
    return "cleanup";
  }
  if (status !== "running") return "retained";

  const session = await loadRunSession(run, dependencies);
  if (!heartbeatIsStale(run, session, dependencies)) return "retained";
  const health = await probeRunner(session, dependencies);
  const cloudRun = await lookupRunService(run, session, dependencies);
  if (health.ok) {
    if (!cloudRun.ok) {
      await markReconciliationError(run.runId, cloudRun.errorCode, dependencies);
      return "retained";
    }
    await markHealthy(run.runId, dependencies);
    return "healthy";
  }

  if (!cloudRun.ok) {
    await markReconciliationError(run.runId, cloudRun.errorCode, dependencies);
    return "retained";
  }
  await requestInterruptedCleanup(run.runId, health.errorCode, dependencies);
  await dependencies.cleanupAutomationRun(run.runId);
  return "interrupted";
}

function heartbeatIsStale(run, session, dependencies = {}) {
  const heartbeat = latestTimestamp(
      run.executionHeartbeatAt,
      session.automationExecutionHeartbeatAt,
      run.startedAt,
      run.admittedAt,
      run.updatedAt,
  );
  return heartbeat > 0 && dependencies.now() - heartbeat >= dependencies.heartbeatMaxAgeMs;
}

async function probeRunner(session, dependencies = {}) {
  if (!session.serviceUrl || !session.shutdownToken) {
    return {ok: false, errorCode: "automation_runner_unreachable"};
  }
  const startedAt = Date.now();
  try {
    const health = typeof dependencies.healthProbe === "function" ?
      await dependencies.healthProbe(session) :
      // Cloud Run intercepts bare /healthz; Express accepts the trailing slash.
      await dependencies.requestRunnerJson(session, "/healthz/", {
        timeoutMs: dependencies.healthProbeTimeoutMs,
        unavailableError: "automation_runner_unreachable",
      });
    return health && health.ok !== false ? {ok: true} : {ok: false, errorCode: "automation_runner_unhealthy"};
  } catch (error) {
    const errorCode = stableReconciliationErrorCode(error, "automation_runner_unreachable");
    logger.warn("automation runner health probe failed", {
      runId: session.automationRunId || null,
      sessionId: session.id || null,
      route: "/healthz/",
      httpStatus: Number.isInteger(error?.runnerHttpStatus) ? error.runnerHttpStatus : Number.isInteger(error?.status) ? error.status : null,
      durationMs: Date.now() - startedAt,
      errorCode,
    });
    return {ok: false, errorCode};
  }
}

async function lookupRunService(run, session, dependencies = {}) {
  const serviceName = deterministicServiceName(run, session);
  if (!serviceName) return {ok: false, errorCode: "automation_service_name_missing"};
  try {
    const service = await getCloudRunService(serviceName, dependencies);
    if (!service) return {ok: true, exists: false, serviceName};
    const expected = cloudRunServiceLabels({
      automationRunId: run.runId,
      ownerUid: run.ownerUid,
      runtimeKind: "automation",
      workspaceId: run.workspaceId,
    });
    const labels = service.labels || service.metadata?.labels || {};
    if (Object.entries(expected).some(([key, value]) => labels[key] !== value)) {
      return {ok: false, errorCode: "cloud_run_service_identity_mismatch", serviceName};
    }
    return {ok: true, exists: true, serviceName};
  } catch (error) {
    return {ok: false, errorCode: stableReconciliationErrorCode(error, "automation_service_lookup_failed")};
  }
}

async function requestInterruptedCleanup(runId, reason, dependencies = {}) {
  const runRef = dependencies.db.collection("automationRuns").doc(runId);
  const now = serverTimestamp(dependencies.admin);
  await dependencies.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(runRef);
    if (!snap.exists) return;
    const run = snap.data() || {};
    if (isTerminalAutomationStatus(run.status)) return;
    transaction.update(runRef, {
      status: "stopping",
      desiredOutcome: run.desiredOutcome === "canceled" ? "canceled" : "interrupted",
      interruptionReason: run.interruptionReason || reason || "automation_runner_unreachable",
      cleanupState: "pending",
      updatedAt: now,
    });
  });
}

async function markHealthy(runId, dependencies = {}) {
  const ref = dependencies.db.collection("automationRuns").doc(runId);
  await ref.update({
    reconciliationLastHealthyAt: serverTimestamp(dependencies.admin),
    reconciliationLastAction: "healthy",
    reconciliationErrorCode: null,
    updatedAt: serverTimestamp(dependencies.admin),
  });
}

async function markReconciliationError(runId, code, dependencies = {}) {
  const ref = dependencies.db.collection("automationRuns").doc(runId);
  await ref.update({
    reconciliationLastAction: "retained",
    reconciliationErrorCode: code,
    updatedAt: serverTimestamp(dependencies.admin),
  });
}

async function loadRunSession(run, dependencies = {}) {
  const sessionId = String(run.sessionId || automationSessionId(run.runId)).trim();
  const ref = dependencies.sessionCollection(run.workspaceId).doc(sessionId);
  const snap = await ref.get();
  return snap.exists ? {id: snap.id, ...snap.data()} : {
    id: sessionId,
    automationRunId: run.runId,
    runtimeKind: "automation",
    ownerUid: run.ownerUid,
    workspaceId: run.workspaceId,
  };
}

async function listActiveRuns(dependencies = {}) {
  if (typeof dependencies.listRuns === "function") return dependencies.listRuns(PAGE_SIZE, MAX_RUN_PAGES);
  let query = dependencies.db.collection("automationRuns");
  if (typeof query.where === "function") query = query.where("status", "in", RECONCILIATION_RUN_STATUSES);
  if (typeof query.orderBy === "function") query = query.orderBy("updatedAt", "asc");
  const runs = [];
  for (let page = 0; page < MAX_RUN_PAGES && query; page++) {
    const pageQuery = typeof query.limit === "function" ? query.limit(PAGE_SIZE) : query;
    const snap = await pageQuery.get();
    const docs = Array.isArray(snap.docs) ? snap.docs : [];
    runs.push(...docs.map((doc) => ({runId: doc.id, ...doc.data()})));
    if (docs.length < PAGE_SIZE || typeof query.startAfter !== "function") break;
    query = query.startAfter(docs[docs.length - 1]);
  }
  return runs.filter((run) => runNeedsRuntime(run));
}

function runNeedsRuntime(run = {}) {
  const status = normalize(run.status);
  return ACTIVE_RUN_STATUSES.includes(status) ||
    (isTerminalAutomationStatus(status) && normalize(run.cleanupState) !== "complete");
}

async function reconcileOrphanServices(liveAutomationLabels, dependencies = {}) {
  let services;
  try {
    services = await listCloudRunServices(dependencies);
  } catch (error) {
    logger.warn("automation orphan inventory failed", {
      code: stableReconciliationErrorCode(error, "automation_service_list_failed"),
    });
    return {checked: 0, deleted: 0, errors: 1};
  }
  const result = {checked: 0, deleted: 0, errors: 0};
  for (const listed of services) {
    const labels = listed.labels || listed.metadata?.labels || {};
    if (labels["mapache-runtime-kind"] !== "automation") continue;
    result.checked += 1;
    const serviceName = listed.name;
    if (!serviceName || liveAutomationLabels.has(labels["mapache-automation-run"])) continue;
    try {
      const current = await getCloudRunService(serviceName, dependencies);
      const currentLabels = current?.labels || current?.metadata?.labels || {};
      if (currentLabels["mapache-runtime-kind"] !== "automation" ||
          currentLabels["mapache-automation-run"] !== labels["mapache-automation-run"] ||
          liveAutomationLabels.has(currentLabels["mapache-automation-run"])) continue;
      await deleteCloudRunService(serviceName, dependencies);
      result.deleted += 1;
    } catch (error) {
      if (!isGoogleNotFound(error)) result.errors += 1;
    }
  }
  return result;
}

async function listCloudRunServices(dependencies = {}) {
  if (typeof dependencies.listCloudRunServices === "function") return dependencies.listCloudRunServices();
  const client = await cloudRunClient(dependencies);
  const project = await projectId(client, dependencies);
  const services = [];
  let pageToken = "";
  for (let page = 0; page < MAX_SERVICE_PAGES; page++) {
    const params = new URLSearchParams({
      pageSize: String(PAGE_SIZE),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await client.request({
      // Cloud Run v2 requires a concrete region and has no label filter.
      // Automation creation uses DEFAULT_REGION; label checks stay below
      // the inventory boundary and are repeated before deleting a service.
      url: `https://run.googleapis.com/v2/projects/${project}/locations/${DEFAULT_REGION}/services?${params.toString()}`,
      method: "GET",
    });
    services.push(...(response.data?.services || []));
    pageToken = String(response.data?.nextPageToken || "");
    if (!pageToken) break;
  }
  return services;
}

async function getCloudRunService(serviceName, dependencies = {}) {
  if (typeof dependencies.getCloudRunService === "function") return dependencies.getCloudRunService(serviceName);
  const client = await cloudRunClient(dependencies);
  try {
    const response = await client.request({url: `https://run.googleapis.com/v2/${serviceName}`, method: "GET"});
    return response.data || {};
  } catch (error) {
    if (isGoogleNotFound(error)) return null;
    throw error;
  }
}

async function deleteCloudRunService(serviceName, dependencies = {}) {
  if (typeof dependencies.deleteCloudRunService === "function") {
    return dependencies.deleteCloudRunService(serviceName);
  }
  const client = await cloudRunClient(dependencies);
  const response = await client.request({url: `https://run.googleapis.com/v2/${serviceName}`, method: "DELETE"});
  await waitForOperation(client, response.data, {
    operationTimeoutMs: dependencies.operationTimeoutMs || DEFAULT_CLOUD_RUN_OPERATION_TIMEOUT_MS,
  });
  await waitForCloudRunServiceDeleted(client, serviceName, {
    operationTimeoutMs: dependencies.operationTimeoutMs || DEFAULT_CLOUD_RUN_OPERATION_TIMEOUT_MS,
  });
  return {serviceAbsent: true};
}

async function cloudRunClient(dependencies = {}) {
  return (dependencies.auth || defaultAuth).getClient();
}

async function projectId(client, dependencies = {}) {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || dependencies.projectId || client.getProjectId();
}

function deterministicServiceName(run, session = {}) {
  const region = String(session.region || run.region || DEFAULT_REGION).trim();
  return cloudRunServiceName(region, automationCloudRunServiceId(run.runId));
}

function latestTimestamp(...values) {
  return values.reduce((latest, value) => Math.max(latest, timestampMillis(value)), 0);
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  if (value && typeof value._seconds === "number") return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function serverTimestamp(admin) {
  return admin.firestore.FieldValue.serverTimestamp();
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function stableReconciliationErrorCode(error, fallback = "automation_reconciliation_failed") {
  const code = normalize(error?.code || error?.publicMessage || fallback);
  if (/^[a-z0-9_:-]{1,120}$/.test(code)) return code;
  return fallback;
}

module.exports = {
  ACTIVE_RUN_STATUSES,
  createAutomationReconciliationService,
  reconcile,
};
