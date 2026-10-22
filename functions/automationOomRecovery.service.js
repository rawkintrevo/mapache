"use strict";

const crypto = require("node:crypto");
const {admin: defaultAdmin, auth: defaultAuth, db: defaultDb} = require("./backendContext");
const {automationCloudRunServiceId} = require("./provisioning.helpers");
const {automationSessionId} = require("./runtimePaths.helpers");
const {createRun} = require("./automationRuns.service");
const {isValidSessionResourcePair, parseMemoryGiB} = require("./sessionResources.helpers");
const catalog = require("./sessionResourceCatalog.json");

const MAX_OOM_RETRIES = 2;
const SYSTEM_LOG = "run.googleapis.com%2Fvarlog%2Fsystem";

function createAutomationOomRecoveryService(dependencies = {}) {
  const shared = {admin: defaultAdmin, auth: defaultAuth, db: defaultDb, ...dependencies};
  return {
    inspectRun: (runId) => inspectRun(runId, shared),
    retryAfterDeletion: (runId) => retryAfterDeletion(runId, shared),
  };
}

// A platform memory-limit event is evidence; a timeout, exit 137, or a user log is not.
async function readOomEvidence(run, session, dependencies) {
  const serviceId = automationCloudRunServiceId(run.runId);
  if (session.serviceId !== serviceId) return null;
  const since = timestampIso(session.provisioningAttemptStartedAt || run.admittedAt || run.createdAt);
  if (!since) return null;
  const auth = dependencies.auth || defaultAuth;
  const project = dependencies.projectId || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || await auth.getProjectId();
  const client = await auth.getClient();
  const response = await client.request({
    url: "https://logging.googleapis.com/v2/entries:list",
    method: "POST",
    timeout: 10000,
    data: {
      resourceNames: [`projects/${project}`],
      filter: [
        'resource.type="cloud_run_revision"',
        `resource.labels.service_name="${serviceId}"`,
        'log_id("run.googleapis.com/varlog/system")',
        `timestamp >= "${since}"`,
        'textPayload:"Memory limit of"',
        'textPayload:"exceeded"',
      ].join(" AND "),
      orderBy: "timestamp desc",
      pageSize: 10,
    },
  });
  const entry = (response.data?.entries || []).find((item) =>
    item.logName === `projects/${project}/logs/${SYSTEM_LOG}` &&
    item.resource?.labels?.service_name === serviceId &&
    timestampIso(item.timestamp) >= since &&
    /Memory limit of [\d.]+ \w+ exceeded/i.test(item.textPayload || ""));
  return entry ? {timestamp: entry.timestamp, revision: entry.resource.labels.revision_name || null} : null;
}

async function inspectRun(runId, dependencies) {
  const ref = dependencies.db.collection("automationRuns").doc(runId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const run = {runId, ...snap.data()};
  if (!canInspect(run)) return false;
  if (run.oomPhase) return true;
  const sessionRef = dependencies.sessionCollection(run.workspaceId).doc(run.sessionId || automationSessionId(runId));
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) return false;
  const evidence = await (dependencies.readOomEvidence || readOomEvidence)(run, sessionSnap.data(), dependencies);
  if (!evidence) return false;
  return dependencies.db.runTransaction(async (transaction) => {
    const currentSnap = await transaction.get(ref);
    const currentSession = await transaction.get(sessionRef);
    if (!currentSnap.exists || !canInspect(currentSnap.data())) return false;
    const current = currentSnap.data();
    const phase = executionBegan(current, currentSession.data() || {}) ? "execution" : "provisioning";
    transaction.update(ref, {
      status: ["failed", "interrupted"].includes(current.status) ? current.status : "stopping",
      desiredOutcome: "failed",
      oomPhase: phase,
      oomLogTimestamp: evidence.timestamp,
      oomRevision: evidence.revision || null,
      provisioningErrorCode: phase === "provisioning" ? "automation_provisioning_oom" : null,
      executionErrorCode: phase === "execution" ? "automation_execution_oom" : null,
      cleanupState: "pending",
      updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });
}

function canInspect(run) {
  return run.cleanupState !== "complete" && run.desiredOutcome !== "canceled" &&
    ["provisioning", "running", "stopping", "failed", "interrupted"].includes(run.status);
}

function executionBegan(run, session = {}) {
  return Boolean(run.executionStartedAt || run.startedAt || run.executionState ||
    session.automationExecutionState || session.automationExecutionBootInstanceId);
}

// Called only after cleanup has confirmed service absence. The transaction checks
// the execution claim again: a runner may have claimed it while deletion was in flight.
async function retryAfterDeletion(runId, dependencies) {
  const db = dependencies.db;
  const ref = db.collection("automationRuns").doc(runId);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return {retried: false};
    const run = {runId, ...snap.data()};
    if (run.oomRetryRunId) return {retried: true, runId: run.oomRetryRunId};
    if (!run.oomPhase || run.desiredOutcome === "canceled" || run.status === "canceled" ||
        !["stopping", "failed", "interrupted"].includes(run.status)) return {retried: false};
    const sessionSnap = await transaction.get(dependencies.sessionCollection(run.workspaceId)
        .doc(run.sessionId || automationSessionId(runId)));
    const session = sessionSnap.data() || {};
    const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
    if (run.oomPhase === "execution" || executionBegan(run, session)) {
      transaction.update(ref, {oomPhase: "execution", provisioningErrorCode: null,
        executionErrorCode: "automation_execution_oom", oomRecoveryReason: "execution_started", updatedAt: now});
      return {retried: false};
    }
    // Workspace requests retain one durable caller ticket across startup attempts.
    if (!run.ticketId || run.workspaceRunRequest?.triggerKind !== "http_ticket") return {retried: false};
    const count = Number(run.oomRetryCount || 0);
    const resources = nextResources(session.resources || run.snapshot?.resources);
    if (count >= MAX_OOM_RETRIES || !resources) {
      transaction.update(ref, {oomRecoveryReason: count >= MAX_OOM_RETRIES ? "retry_limit" : "resource_ceiling", updatedAt: now});
      return {retried: false};
    }
    const ticketRef = db.collection("workspaceTickets").doc(run.ticketId);
    const ticketSnap = await transaction.get(ticketRef);
    const workspaceSnap = await transaction.get(db.collection("workspaces").doc(run.workspaceId));
    const ticket = ticketSnap.data() || {};
    const workspace = workspaceSnap.data() || {};
    if (!ticketSnap.exists || ticket.runId !== runId || ticket.status === "canceled" ||
        ticket.ownerUid !== run.ownerUid || ticket.workspaceId !== run.workspaceId ||
        !workspaceSnap.exists || workspace.ownerUid !== run.ownerUid || workspace.deleted ||
        ["deleting", "deleted"].includes(workspace.lifecycle || workspace.status)) return {retried: false};
    const retryId = `ticket-oom-${crypto.createHash("sha256").update(runId).digest("hex")}`;
    const retryRef = db.collection("automationRuns").doc(retryId);
    const retrySnap = await transaction.get(retryRef);
    if (retrySnap.exists) throw new Error("oom_retry_identity_conflict");
    const retry = createRun({
      actorUid: run.ownerUid, ownerUid: run.ownerUid, workspaceId: run.workspaceId,
      automationId: run.automationId, runId: retryId, rootRunId: run.rootRunId || runId,
      retryOfRunId: runId, attemptNumber: Number(run.attemptNumber || 0) + 1,
      status: "queued", trigger: "http_ticket", now,
      snapshot: {...run.snapshot, resources},
      workspaceRunRequest: {...run.workspaceRunRequest, resources},
    });
    Object.assign(retry, {ticketId: run.ticketId, oomRetryCount: count + 1});
    for (const key of ["chromeProfileSeed", "chromeProfileInitialization", "contextResolution"]) {
      if (run[key] || session[key]) retry[key] = run[key] || session[key];
    }
    transaction.set(retryRef, retry);
    transaction.update(ref, {oomRetryRunId: retryId, oomRecoveryReason: "larger_runner_queued", updatedAt: now});
    transaction.update(ticketRef, {runId: retryId, status: "queued", errorCode: null,
      result: null, resultPublishedAt: null, updatedAt: now});
    return {retried: true, runId: retryId, resources};
  });
}

function nextResources(resources = {}) {
  const memory = parseMemoryGiB(resources?.memory);
  const cpu = Number(resources?.cpu);
  if (!memory || !cpu) return null;
  const nextMemory = catalog.advanced.memory.find((value) => parseMemoryGiB(value) > memory);
  if (!nextMemory) return null;
  const nextCpu = catalog.advanced.cpu.find((value) => Number(value) >= cpu && isValidSessionResourcePair(value, nextMemory));
  return nextCpu ? {cpu: nextCpu, memory: nextMemory} : null;
}

function timestampIso(value) {
  const date = value?.toDate ? value.toDate() : new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

module.exports = {MAX_OOM_RETRIES, createAutomationOomRecoveryService, executionBegan, nextResources, readOomEvidence};
