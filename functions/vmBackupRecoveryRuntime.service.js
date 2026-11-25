"use strict";

const {createHash, randomBytes} = require("node:crypto");
const {normalizeRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {runtimeStateDigest} = require("./vmBackupRuntimeEvidence.service");
const {tokenHash} = require("./vmRuntimeControl.service");

const RUNTIME_COLLECTION = "vmBackupRecoveryRuntimes_v2";
const CREDENTIALS_COLLECTION = "vmBackupRecoveryCredentials_v2";
const ROUTES_COLLECTION = "vmGatewayRoutes_v2";
const DEFAULT_CONTROL_URL = "https://us-central1-pi-agents-cloud.cloudfunctions.net/vmBackupRecoveryControl_v2";
const SUBNETWORK = "projects/pi-agents-cloud/regions/us-central1/subnetworks/mapache-vm-v2-us-central1";
const HOST_PATTERN = /^backup-recovery---[a-z0-9.-]{1,180}\.run\.app$/;
const IMAGE_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const START_TIMEOUT_MS = 10 * 60 * 1000;
const DEADLINE_MS = 15 * 60 * 1000;

function createVmBackupRecoveryRuntimeService({
  db,
  compute,
  gatewayHost = process.env.VM_BACKUP_RECOVERY_GATEWAY_HOST,
  runnerImage = process.env.SESSION_RUNNER_IMAGE,
  controlUrl = process.env.VM_BACKUP_RECOVERY_CONTROL_URL || DEFAULT_CONTROL_URL,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)),
  startTimeoutMs = START_TIMEOUT_MS,
} = {}) {
  if (!db || !compute || typeof compute.start !== "function" || typeof compute.inspect !== "function" ||
      typeof compute.deleteOwnedDisk !== "function" || typeof fetchImpl !== "function") {
    throw new Error("vm_backup_recovery_runtime_dependencies_required");
  }

  return {verify, cleanup};

  async function verify(restoreReceipt, input = {}) {
    const startedAtMs = now();
    const context = configuration(restoreReceipt, input);
    let staged = await readContext(context);
    if (!staged) staged = await reserve(context);
    const credentials = staged.credentials;
    context.credentials = credentials;
    const descriptor = context.descriptor;
    const existing = await compute.inspect(descriptor);
    if (!existing.instance) {
      await compute.start(descriptor, {
        operationId: context.operationId,
        allowCreateDisk: false,
        requireCreationMatch: true,
        requireOperationMatch: true,
        runnerImage: context.runnerImage,
        subnetwork: SUBNETWORK,
        timeoutMs: 240000,
        env: runnerEnvironment(context, credentials),
      });
    } else {
      assertResourceIdentity(existing, context);
    }
    const observed = await compute.inspect(descriptor);
    if (!observed.instance?.privateAddress) throw runtimeError("vm_backup_recovery_private_address_missing");
    const leaseStartedAtMs = now();
    await waitForLease(context);
    await enableRoute(context, observed.instance.privateAddress);
    const healthStartedAtMs = now();
    const health = await requestJson(context, "/runner/health");
    const healthAtMs = now();
    const digest = await requestJson(context, "/runner/recovery-digest");
    const digestAtMs = now();
    if (health.ok !== true || health.workspaceId !== context.workspaceId ||
        health.sessionId !== context.sessionId || health.agentRuntime?.ready !== true) {
      throw runtimeError("vm_backup_recovery_runtime_not_ready");
    }
    if (digest.ok !== true || digest.workspaceId !== context.workspaceId || digest.sessionId !== context.sessionId ||
        !DIGEST_PATTERN.test(String(digest.fileDigest || "")) || !Number.isSafeInteger(digest.entryCount) ||
        !Number.isSafeInteger(digest.byteCount)) throw runtimeError("vm_backup_recovery_digest_invalid");
    const finalObserved = await compute.inspect(descriptor);
    assertResourceIdentity(finalObserved, context);
    return {
      version: 1,
      runtimeReady: true,
      fileDigest: digest.fileDigest,
      runtimeStateDigest: runtimeStateDigest(health),
      diskId: finalObserved.disk?.id || null,
      entryCount: digest.entryCount,
      byteCount: digest.byteCount,
      startupStageTimingsMs: {
        boot: Math.max(0, leaseStartedAtMs - startedAtMs),
        health: Math.max(0, healthAtMs - healthStartedAtMs),
        digest: Math.max(0, digestAtMs - healthAtMs),
        total: Math.max(0, digestAtMs - startedAtMs),
      },
    };
  }

  async function cleanup(restoreReceipt, input = {}) {
    const startedAtMs = now();
    const context = configuration(restoreReceipt, input);
    await disableRoute(context);
    const observed = await compute.inspect(context.descriptor);
    if (observed.instance) {
      await compute.deleteOwnedInstance(context.descriptor, {
        operationId: context.operationId,
        requireOperationMatch: true,
        timeoutMs: 240000,
      });
    }
    const detached = await waitForDetached(context, 240000);
    if (detached.instance) throw runtimeError("vm_backup_recovery_instance_cleanup_pending");
    if (detached.disk) {
      await deleteDetachedDisk(context, 240000);
    }
    const remaining = await compute.inspect(context.descriptor);
    if (remaining.instance || remaining.disk) throw runtimeError("vm_backup_recovery_cleanup_pending");
    await removeRecords(context);
    return {
      instanceDeleted: true,
      diskDeleted: true,
      timingsMs: {total: Math.max(0, now() - startedAtMs)},
    };
  }

  async function waitForDetached(context, timeoutMs) {
    const deadline = now() + timeoutMs;
    let observed;
    do {
      observed = await compute.inspect(context.descriptor);
      if (!observed.instance && (!observed.disk || observed.disk.users.length === 0)) return observed;
      if (now() >= deadline) break;
      await sleep(Math.min(2000, Math.max(1, deadline - now())));
    } while (now() < deadline);
    return observed;
  }

  async function deleteDetachedDisk(context, timeoutMs) {
    const deadline = now() + timeoutMs;
    let lastError;
    while (now() < deadline) {
      const observed = await waitForDetached(context, Math.min(2000, Math.max(1, deadline - now())));
      if (observed.instance) throw runtimeError("vm_backup_recovery_instance_cleanup_pending");
      if (!observed.disk) return {diskDeleted: true};
      try {
        return await compute.deleteOwnedDisk(context.descriptor, {operationId: context.operationId, timeoutMs: Math.max(1, deadline - now())});
      } catch (error) {
        if (!new Set(["runtime_data_disk_attached", "runtime_data_disk_cleanup_unverified", "runtime_data_disk_cleanup_pending"]).has(error?.code)) throw error;
        lastError = error;
        await sleep(Math.min(2000, Math.max(1, deadline - now())));
      }
    }
    throw lastError || runtimeError("vm_backup_recovery_disk_cleanup_pending");
  }

  function configuration(restoreReceipt, input) {
    const workspaceId = identity(input.workspaceId);
    const ownerUid = identity(input.ownerUid);
    const operationId = identity(input.operationId);
    if (!restoreReceipt || restoreReceipt.kind !== "compute-engine-restore" ||
        restoreReceipt.workspaceId !== workspaceId || restoreReceipt.ownerUid !== ownerUid ||
        restoreReceipt.operationId !== operationId || !identity(restoreReceipt.targetDisk) ||
        !identity(restoreReceipt.targetZone)) throw runtimeError("vm_backup_recovery_receipt_invalid");
    const host = String(gatewayHost || "").trim();
    if (!HOST_PATTERN.test(host)) throw runtimeError("vm_backup_recovery_gateway_unconfigured");
    if (!IMAGE_PATTERN.test(String(runnerImage || "").trim())) throw runtimeError("vm_backup_recovery_runner_image_unpinned");
    let control;
    try { control = new URL(controlUrl); } catch { throw runtimeError("vm_backup_recovery_control_url_invalid"); }
    if (control.protocol !== "https:" || control.username || control.password || control.search || control.hash) {
      throw runtimeError("vm_backup_recovery_control_url_invalid");
    }
    const sourceGeneration = Number(restoreReceipt.sourceGeneration);
    if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 1) throw runtimeError("vm_backup_recovery_generation_invalid");
    const sessionId = `vm-backup-${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
    const instanceName = `mapache-recovery-vm-${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
    const descriptor = normalizeRuntimeDescriptor({version: 1, backend: "compute-engine", workspaceId, ownerUid,
      zone: restoreReceipt.targetZone, generation: sourceGeneration, dataDiskName: restoreReceipt.targetDisk, instanceName},
    {workspaceId, ownerUid});
    return {workspaceId, ownerUid, operationId, sessionId, host, deadlineMs: now() + DEADLINE_MS,
      runnerImage: String(runnerImage).trim(), controlUrl: control.toString(), descriptor};
  }

  async function reserve(context) {
    const runtimeRef = db.collection(RUNTIME_COLLECTION).doc(context.workspaceId);
    const sessionRef = runtimeRef.collection("sessions").doc(context.sessionId);
    const credentialsRef = db.collection(CREDENTIALS_COLLECTION).doc(context.sessionId);
    const routeRef = db.collection(ROUTES_COLLECTION).doc(context.host);
    const credentials = {ownerUid: context.ownerUid, generation: context.descriptor.generation,
      recoveryOperationId: context.operationId, controlToken: randomToken(), browserToken: randomToken(), shutdownToken: randomToken()};
    const runtime = {version: 1, kind: "vm-backup-recovery-runtime", recoveryOnly: true,
      recoveryOperationId: context.operationId, workspaceId: context.workspaceId, ownerUid: context.ownerUid,
      backend: "compute-engine", generation: context.descriptor.generation, state: "reserved",
      currentSessionId: context.sessionId, leaseExpiresAt: 0, bootId: null, deadlineMs: context.deadlineMs};
    const session = {version: 1, recoveryOnly: true, recoveryOperationId: context.operationId,
      ownerUid: context.ownerUid, generation: context.descriptor.generation, state: "reserved", bootId: null,
      leaseExpiresAt: 0, controlTokenHash: tokenHash(credentials.controlToken)};
    const route = {version: 1, recoveryOnly: true, enabled: false, workspaceId: context.workspaceId,
      ownerUid: context.ownerUid, operationId: context.operationId, sessionId: context.sessionId,
      generation: context.descriptor.generation, deadlineMs: context.deadlineMs};
    await db.runTransaction(async tx => {
      const [existingRuntime, existingSession, existingCredentials, existingRoute] = await Promise.all([
        tx.get(runtimeRef), tx.get(sessionRef), tx.get(credentialsRef), tx.get(routeRef),
      ]);
      if (existingRuntime.exists || existingSession.exists || existingCredentials.exists || existingRoute.exists) {
        if (!existingRuntime.exists || !existingSession.exists || !existingCredentials.exists || !existingRoute.exists) {
          throw runtimeError("vm_backup_recovery_resource_conflict");
        }
        assertContext(await readContext(context), context);
        return;
      }
      tx.create(runtimeRef, runtime);
      tx.create(sessionRef, session);
      tx.create(credentialsRef, credentials);
      tx.create(routeRef, route);
    });
    return {runtime, session, credentials, route};
  }

  async function readContext(context) {
    const runtimeRef = db.collection(RUNTIME_COLLECTION).doc(context.workspaceId);
    const runtimeSnap = await runtimeRef.get();
    if (!runtimeSnap.exists) return null;
    const runtime = runtimeSnap.data() || {};
    const sessionSnap = await runtimeRef.collection("sessions").doc(runtime.currentSessionId || context.sessionId).get();
    const credentialsSnap = await db.collection(CREDENTIALS_COLLECTION).doc(runtime.currentSessionId || context.sessionId).get();
    const routeSnap = await db.collection(ROUTES_COLLECTION).doc(context.host).get();
    if (!sessionSnap.exists || !credentialsSnap.exists || !routeSnap.exists) throw runtimeError("vm_backup_recovery_resource_conflict");
    const value = {runtime, session: sessionSnap.data() || {}, credentials: credentialsSnap.data() || {}, route: routeSnap.data() || {}};
    if (Number.isSafeInteger(value.route.deadlineMs)) context.deadlineMs = value.route.deadlineMs;
    assertContext(value, context);
    return value;
  }

  function assertContext(value, context) {
    if (!value || value.runtime.recoveryOnly !== true || value.runtime.recoveryOperationId !== context.operationId ||
        value.runtime.ownerUid !== context.ownerUid || value.runtime.currentSessionId !== context.sessionId ||
        value.session.recoveryOperationId !== context.operationId || value.session.ownerUid !== context.ownerUid ||
        value.session.generation !== context.descriptor.generation || value.credentials.ownerUid !== context.ownerUid ||
        value.credentials.recoveryOperationId !== context.operationId || value.route.recoveryOnly !== true ||
        value.route.operationId !== context.operationId || value.route.workspaceId !== context.workspaceId ||
        value.route.ownerUid !== context.ownerUid || value.route.sessionId !== context.sessionId ||
        value.route.generation !== context.descriptor.generation) throw runtimeError("vm_backup_recovery_authority_changed");
  }

  async function waitForLease(context) {
    const until = Math.min(context.deadlineMs, now() + startTimeoutMs);
    const runtimeRef = db.collection(RUNTIME_COLLECTION).doc(context.workspaceId);
    while (now() < until) {
      const snapshot = await runtimeRef.get();
      const runtime = snapshot.data() || {};
      if (snapshot.exists && runtime.recoveryOperationId === context.operationId && runtime.state === "active" &&
          runtime.bootId && runtime.leaseExpiresAt > now()) return runtime;
      await sleep(Math.min(2000, Math.max(1, until - now())));
    }
    throw runtimeError("vm_backup_recovery_lease_timeout");
  }

  async function enableRoute(context, address) {
    const runtimeRef = db.collection(RUNTIME_COLLECTION).doc(context.workspaceId);
    const routeRef = db.collection(ROUTES_COLLECTION).doc(context.host);
    await db.runTransaction(async tx => {
      const [runtimeSnap, sessionSnap, routeSnap] = await Promise.all([
        tx.get(runtimeRef), tx.get(runtimeRef.collection("sessions").doc(context.sessionId)), tx.get(routeRef),
      ]);
      const runtime = runtimeSnap.data() || {};
      const session = sessionSnap.data() || {};
      const route = routeSnap.data() || {};
      if (!runtimeSnap.exists || !sessionSnap.exists || !routeSnap.exists || runtime.recoveryOperationId !== context.operationId ||
          session.recoveryOperationId !== context.operationId || route.operationId !== context.operationId ||
          route.recoveryOnly !== true || runtime.state !== "active" || session.state !== "active" ||
          runtime.currentSessionId !== context.sessionId || route.sessionId !== context.sessionId ||
          (route.enabled === true && route.address !== address)) throw runtimeError("vm_backup_recovery_route_authority_lost");
      if (route.enabled !== true || route.address !== address) tx.update(routeRef, {enabled: true, address});
    });
  }

  async function disableRoute(context) {
    const runtimeRef = db.collection(RUNTIME_COLLECTION).doc(context.workspaceId);
    const routeRef = db.collection(ROUTES_COLLECTION).doc(context.host);
    await db.runTransaction(async tx => {
      const [runtimeSnap, sessionSnap, routeSnap] = await Promise.all([
        tx.get(runtimeRef), tx.get(runtimeRef.collection("sessions").doc(context.sessionId)), tx.get(routeRef),
      ]);
      if (!runtimeSnap.exists && !sessionSnap.exists && !routeSnap.exists) return;
      const runtime = runtimeSnap.data() || {};
      const session = sessionSnap.data() || {};
      const route = routeSnap.data() || {};
      if ((runtimeSnap.exists && (runtime.recoveryOperationId !== context.operationId || runtime.ownerUid !== context.ownerUid)) ||
          (sessionSnap.exists && session.recoveryOperationId !== context.operationId) ||
          (routeSnap.exists && (route.recoveryOnly !== true || route.operationId !== context.operationId ||
            route.ownerUid !== context.ownerUid))) throw runtimeError("vm_backup_recovery_authority_changed");
      if (routeSnap.exists) tx.update(routeRef, {enabled: false});
      if (runtimeSnap.exists) tx.update(runtimeRef, {state: "stopping", leaseExpiresAt: 0});
      if (sessionSnap.exists) tx.update(runtimeRef.collection("sessions").doc(context.sessionId), {state: "stopping", leaseExpiresAt: 0});
    });
  }

  async function removeRecords(context) {
    const runtimeRef = db.collection(RUNTIME_COLLECTION).doc(context.workspaceId);
    const sessionRef = runtimeRef.collection("sessions").doc(context.sessionId);
    const credentialsRef = db.collection(CREDENTIALS_COLLECTION).doc(context.sessionId);
    const routeRef = db.collection(ROUTES_COLLECTION).doc(context.host);
    await db.runTransaction(async tx => {
      const [runtimeSnap, sessionSnap, credentialsSnap, routeSnap] = await Promise.all([
        tx.get(runtimeRef), tx.get(sessionRef), tx.get(credentialsRef), tx.get(routeRef),
      ]);
      const runtime = runtimeSnap.data() || {};
      const session = sessionSnap.data() || {};
      const credentials = credentialsSnap.data() || {};
      const route = routeSnap.data() || {};
      if ((runtimeSnap.exists && (runtime.recoveryOperationId !== context.operationId || runtime.ownerUid !== context.ownerUid)) ||
          (sessionSnap.exists && session.recoveryOperationId !== context.operationId) ||
          (credentialsSnap.exists && credentials.recoveryOperationId !== context.operationId) ||
          (routeSnap.exists && (route.recoveryOnly !== true || route.operationId !== context.operationId))) {
        throw runtimeError("vm_backup_recovery_authority_changed");
      }
      if (routeSnap.exists) tx.delete(routeRef);
      if (credentialsSnap.exists) tx.delete(credentialsRef);
      if (sessionSnap.exists) tx.delete(sessionRef);
      if (runtimeSnap.exists) tx.delete(runtimeRef);
    });
  }

  async function requestJson(context, pathname) {
    let response;
    try {
      response = await fetchImpl(`https://${context.host}${pathname}`, {method: "GET", redirect: "error",
        headers: {"x-shutdown-token": context.credentials?.shutdownToken || (await readContext(context)).credentials.shutdownToken},
        signal: AbortSignal.timeout(30_000)});
    } catch { throw runtimeError(pathname === "/runner/health" ? "vm_backup_recovery_health_unavailable" : "vm_backup_recovery_digest_unavailable"); }
    if (!response.ok) {
      await response.body?.cancel?.();
      throw runtimeError(pathname === "/runner/health" ? "vm_backup_recovery_health_unavailable" : "vm_backup_recovery_digest_unavailable");
    }
    try { return await response.json(); } catch { throw runtimeError("vm_backup_recovery_response_invalid"); }
  }

  function runnerEnvironment(context, credentials) {
    return {
      GCLOUD_PROJECT: "pi-agents-cloud",
      MAPACHE_VM_CONTROL_URL: context.controlUrl,
      MAPACHE_VM_CONTROL_TOKEN: credentials.controlToken,
      MAPACHE_AGENT_UI_VERSION: "pi-web-ui-v1",
      SESSION_ID: context.sessionId,
      SESSION_BROWSER_TOKEN_SECRET: credentials.browserToken,
      SESSION_SHUTDOWN_TOKEN: credentials.shutdownToken,
      MAPACHE_PI_MODEL_CATALOG_REFRESH: "false",
      RUNNER_CAPABILITIES: JSON.stringify({terminal: true, preview: false, previewQa: false, functions: false, chrome: false}),
    };
  }

  function assertResourceIdentity(observed, context) {
    const operationLabel = createHash("sha256").update(context.operationId).digest("hex").slice(0, 63);
    if (!observed?.disk || observed.disk.labels?.["mapache-operation-id"] !== operationLabel ||
        observed.disk.labels?.["mapache-created-generation"] !== String(context.descriptor.generation) ||
        observed.instance && observed.instance.labels?.["mapache-operation-id"] !== operationLabel) {
      throw runtimeError("vm_backup_recovery_resource_identity_mismatch");
    }
  }

  function identity(value) {
    const result = String(value || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result)) throw runtimeError("vm_backup_recovery_identity_invalid");
    return result;
  }

  function randomToken() { return randomBytes(32).toString("hex"); }
}

function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  return error;
}

module.exports = {
  CREDENTIALS_COLLECTION,
  RUNTIME_COLLECTION,
  createVmBackupRecoveryRuntimeService,
};
