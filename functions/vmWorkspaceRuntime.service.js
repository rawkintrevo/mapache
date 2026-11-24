"use strict";

const {createHash, createHmac} = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const {COMPUTE_ENGINE_BACKEND} = require("./runtimeProvider.helpers");

const VM_COLLECTION = "vmRuntimes_v2";
const VM_CREDENTIALS_COLLECTION = "vmRuntimeCredentials_v2";
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const AGENT_ACCESS_TTL_MS = 15 * 60 * 1000;

/**
 * Adapts the canonical VM runtime to the background-work contract. A VM is
 * one logical workspace machine: background work wakes that machine and uses
 * its current runner, rather than creating a second writer or Cloud Run
 * session against the retained disk.
 */
function createVmWorkspaceRuntimeService({
  db,
  lifecycle,
  now = Date.now,
  delay = defaultDelay,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  if (!db || !lifecycle || typeof lifecycle.request !== "function") {
    throw new Error("vm_workspace_runtime_dependencies_required");
  }

  return {
    ensureReady: (ownerUid, workspaceId, options = {}) =>
      ensureReady(ownerUid, workspaceId, options),
    isVmWorkspace: (ownerUid, workspaceId) => isVmWorkspace(ownerUid, workspaceId),
    readSession: (ownerUid, workspaceId) => readSession(ownerUid, workspaceId),
  };

  async function isVmWorkspace(ownerUid, workspaceId) {
    const runtime = await readRuntime(workspaceId);
    if (!runtime) return false;
    assertOwner(runtime, ownerUid, workspaceId);
    return runtime.backend === COMPUTE_ENGINE_BACKEND;
  }

  async function ensureReady(ownerUid, workspaceId, options = {}) {
    const normalizedWorkspaceId = normalizeId(workspaceId, "workspace_id");
    const runtime = await readRuntime(normalizedWorkspaceId);
    if (!runtime) return null;
    assertOwner(runtime, ownerUid, normalizedWorkspaceId);
    if (runtime.backend !== COMPUTE_ENGINE_BACKEND) return null;
    if (runtime.apiEnabled !== true) throw httpError(404, "workspace_not_found");
    if (runtime.lifecycleEnabled !== true) throw httpError(409, "vm_lifecycle_not_admitted");

    const requestId = normalizeRequestId(options.requestId || `background-${normalizedWorkspaceId}`);
    return waitForReady(ownerUid, normalizedWorkspaceId, options, async (current) => {
      await lifecycle.request({
        workspaceId: normalizedWorkspaceId,
        ownerUid,
        requestId,
        action: "start",
        expectedGeneration: current.generation,
        requireApiAdmission: true,
      });
    });
  }

  async function readSession(ownerUid, workspaceId) {
    const normalizedWorkspaceId = normalizeId(workspaceId, "workspace_id");
    const runtime = await readRuntime(normalizedWorkspaceId);
    if (!runtime) return null;
    assertOwner(runtime, ownerUid, normalizedWorkspaceId);
    if (runtime.backend !== COMPUTE_ENGINE_BACKEND) return null;
    return buildRunnerSession(ownerUid, normalizedWorkspaceId, runtime, {allowNotReady: true});
  }

  async function waitForReady(ownerUid, workspaceId, options = {}, requestStart) {
    const deadline = currentTime() + positiveNumber(options.startupTimeoutMs, startupTimeoutMs);
    let startRequested = false;
    while (currentTime() <= deadline) {
      const runtime = await readRuntime(workspaceId);
      if (!runtime) throw httpError(404, "workspace_not_found");
      assertOwner(runtime, ownerUid, workspaceId);
      if (runtime.backend !== COMPUTE_ENGINE_BACKEND) return null;
      if (isReady(runtime)) return buildRunnerSession(ownerUid, workspaceId, runtime);
      if (runtime.lifecycleEnabled !== true) throw httpError(409, "vm_lifecycle_not_admitted");
      // A request can race a durable pause/replace operation. Wait for that
      // operation to commit stopped, then enqueue one idempotent start using
      // the current generation. Never submit start while another operation is
      // still fencing the runtime.
      if (runtime.state === "stopped" && !runtime.activeOperationId && !startRequested) {
        startRequested = true;
        await requestStart(runtime);
        continue;
      }
      const remaining = deadline - currentTime();
      if (remaining <= 0) break;
      await delay(Math.min(positiveNumber(options.pollIntervalMs, pollIntervalMs), remaining));
    }
    throw httpError(504, "vm_runtime_start_timeout");
  }

  async function readRuntime(workspaceId) {
    const snapshot = await db.collection(VM_COLLECTION).doc(workspaceId).get();
    return snapshot.exists ? {id: snapshot.id || workspaceId, ...snapshot.data()} : null;
  }

  async function buildRunnerSession(ownerUid, workspaceId, runtime, {allowNotReady = false} = {}) {
    const sessionId = String(runtime.currentSessionId || "").trim();
    if (!sessionId) {
      if (allowNotReady) return stoppedSession(ownerUid, workspaceId, runtime);
      throw httpError(503, "vm_runtime_session_unavailable");
    }
    const [sessionSnapshot, credentialsSnapshot] = await Promise.all([
      db.collection(VM_COLLECTION).doc(workspaceId).collection("sessions").doc(sessionId).get(),
      db.collection(VM_CREDENTIALS_COLLECTION).doc(sessionId).get(),
    ]);
    const session = sessionSnapshot.exists ? sessionSnapshot.data() || {} : null;
    const credentials = credentialsSnapshot.exists ? credentialsSnapshot.data() || {} : null;
    if (!session || !credentials || session.ownerUid !== ownerUid || credentials.ownerUid !== ownerUid ||
        session.generation !== runtime.generation || credentials.generation !== runtime.generation) {
      if (allowNotReady) return stoppedSession(ownerUid, workspaceId, runtime);
      throw httpError(503, "vm_runtime_session_unavailable");
    }
    if (!isReady(runtime) || session.state !== "active" || session.bootId !== runtime.bootId ||
        session.leaseExpiresAt <= currentTime() || !runtime.gatewayHost || !credentials.shutdownToken ||
        !credentials.browserToken) {
      if (allowNotReady) return stoppedSession(ownerUid, workspaceId, runtime, sessionId);
      throw httpError(503, "vm_runtime_not_ready");
    }
    const expiresAt = currentTime() + AGENT_ACCESS_TTL_MS;
    const payload = Buffer.from(JSON.stringify({
      sid: sessionId,
      aud: "agent",
      gen: runtime.generation,
      exp: Math.floor(expiresAt / 1000),
    })).toString("base64url");
    const token = `${payload}.${createHmac("sha256", credentials.browserToken).update(payload).digest("base64url")}`;
    return {
      id: sessionId,
      ownerUid,
      workspaceId,
      status: "running",
      serviceUrl: `https://${runtime.gatewayHost}`,
      shutdownToken: credentials.shutdownToken,
      runnerAccessToken: token,
      agentRuntimeGeneration: runtime.generation,
      runtimeProvider: {version: 1, backend: COMPUTE_ENGINE_BACKEND, workspaceId, ownerUid, generation: runtime.generation},
    };
  }

  function stoppedSession(ownerUid, workspaceId, runtime, sessionId = runtime.currentSessionId || null) {
    return {
      id: sessionId,
      ownerUid,
      workspaceId,
      status: runtime.state === "stopped" ? "stopped" : "provisioning",
      serviceUrl: null,
      agentRuntimeGeneration: runtime.generation,
      runtimeProvider: {version: 1, backend: COMPUTE_ENGINE_BACKEND, workspaceId, ownerUid, generation: runtime.generation},
    };
  }

  function isReady(runtime) {
    return runtime.state === "active" && !runtime.activeOperationId && runtime.currentSessionId && runtime.bootId &&
      runtime.lifecycleReadyGeneration === runtime.generation && runtime.leaseExpiresAt > currentTime() &&
      typeof runtime.gatewayHost === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(runtime.gatewayHost);
  }

  function currentTime() {
    const value = typeof now === "function" ? now() : Date.now();
    return value instanceof Date ? value.getTime() : Number(value);
  }
}

function assertOwner(runtime, ownerUid, workspaceId) {
  if (runtime.ownerUid !== ownerUid) throw httpError(404, "workspace_not_found");
  if (runtime.workspaceId && runtime.workspaceId !== workspaceId) throw httpError(409, "vm_workspace_identity_mismatch");
}

function normalizeId(value, field) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) throw httpError(400, `invalid_${field}`);
  return normalized;
}

function normalizeRequestId(value) {
  const normalized = String(value || "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) return normalized;
  return `background-${createHash("sha256").update(normalized).digest("hex").slice(0, 48)}`;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function defaultDelay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

module.exports = {
  AGENT_ACCESS_TTL_MS,
  COMPUTE_ENGINE_BACKEND,
  VM_COLLECTION,
  createVmWorkspaceRuntimeService,
};
