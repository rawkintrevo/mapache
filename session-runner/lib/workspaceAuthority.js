"use strict";

const {randomUUID} = require("node:crypto");

const DEFAULT_RENEWAL_INTERVAL_MS = 5_000;
const ADMISSION_WORKSPACE_STATES = new Set(["starting", "running", "stopping", "deleting"]);
const ADMISSION_SESSION_STATES = new Set(["provisioning", "running", "restarting", "resizing", "stopping", "deleting"]);

/**
 * Fences one physical runner boot inside the generation reserved by Functions.
 *
 * The Firestore workspace/session pair is the authority. A boot is admitted
 * only when both documents name this instance, and every write-facing caller
 * must use assertCurrentWriter before doing work. A failed read is treated as
 * lost authority: the local process stops admitting work and onLost terminates
 * the managed child group.
 */
function createWorkspaceAuthority({
  admin,
  clearIntervalFn = clearInterval,
  config = {},
  db,
  instanceId,
  logger = console,
  now = () => Date.now(),
  onLost,
  randomUUIDImpl = randomUUID,
  setIntervalFn = setInterval,
} = {}) {
  const enabled = config.agentRuntimeEnabled === true || config.agentUiVersion === "pi-web-ui-v1";
  const bootInstanceId = String(instanceId || randomUUIDImpl()).trim();
  const renewalIntervalMs = positiveNumber(
      config.workspaceAuthorityRenewalIntervalMs,
      DEFAULT_RENEWAL_INTERVAL_MS,
  );
  let admitted = false;
  let renewalTimer = null;
  let lossReported = false;

  return {
    acquire,
    assertCurrentWriter,
    enabled: () => enabled,
    isCurrentWriter: () => !enabled || admitted,
    release,
    revokeForQa,
    renew,
    status,
  };

  async function acquire() {
    if (!enabled) return status();
    if (admitted) {
      await assertCurrentWriter();
      return status();
    }
    const refs = authorityRefs();
    await runAuthorityTransaction(async (transaction) => {
      const {workspace, session} = await readAuthority(transaction, refs);
      validateReservation(workspace, session);
      const existingWorkspaceBoot = String(workspace.agentRuntimeBootInstanceId || "").trim();
      const existingSessionBoot = String(session.agentRuntimeBootInstanceId || "").trim();
      const workspaceState = String(workspace.agentRuntimeAuthorityState || "").trim().toLowerCase();
      if (existingWorkspaceBoot || existingSessionBoot) {
        if (existingWorkspaceBoot === bootInstanceId && existingSessionBoot === bootInstanceId && workspaceState === "admitted") {
          return;
        }
        throw authorityError("workspace_runtime_authority_denied");
      }

      const timestamp = serverTimestamp();
      transaction.update(refs.workspaceRef, {
        agentRuntimeAuthorityState: "admitted",
        agentRuntimeBootAcquiredAt: timestamp,
        agentRuntimeBootHeartbeatAt: timestamp,
        agentRuntimeBootInstanceId: bootInstanceId,
      });
      transaction.update(refs.sessionRef, {
        agentRuntimeAuthorityState: "admitted",
        agentRuntimeBootAcquiredAt: timestamp,
        agentRuntimeBootHeartbeatAt: timestamp,
        agentRuntimeBootInstanceId: bootInstanceId,
      });
    });
    admitted = true;
    lossReported = false;
    startRenewal();
    return status();
  }

  async function assertCurrentWriter() {
    if (!enabled) return true;
    if (!admitted) throw authorityError("workspace_writer_authority_lost");
    const refs = authorityRefs();
    try {
      await runAuthorityTransaction(async (transaction) => {
        const {workspace, session} = await readAuthority(transaction, refs);
        validateCurrent(workspace, session);
      });
      return true;
    } catch (error) {
      await loseAuthority(error);
      throw normalizeAuthorityError(error);
    }
  }

  async function renew() {
    if (!enabled || !admitted) return false;
    const refs = authorityRefs();
    try {
      await runAuthorityTransaction(async (transaction) => {
        const {workspace, session} = await readAuthority(transaction, refs);
        validateCurrent(workspace, session);
        const timestamp = serverTimestamp();
        transaction.update(refs.workspaceRef, {agentRuntimeBootHeartbeatAt: timestamp});
        transaction.update(refs.sessionRef, {agentRuntimeBootHeartbeatAt: timestamp});
      });
      return true;
    } catch (error) {
      await loseAuthority(error);
      throw normalizeAuthorityError(error);
    }
  }

  async function release(reason = "shutdown") {
    if (!enabled) return false;
    stopRenewal();
    const wasAdmitted = admitted;
    admitted = false;
    if (!wasAdmitted) return false;
    const refs = authorityRefs();
    try {
      return await runAuthorityTransaction(async (transaction) => {
        const {workspace, session} = await readAuthority(transaction, refs);
        if (!matchesCurrent(workspace, session)) return false;
        const timestamp = serverTimestamp();
        transaction.update(refs.workspaceRef, {
          agentRuntimeAuthorityState: "released",
          agentRuntimeBootHeartbeatAt: timestamp,
          agentRuntimeBootInstanceId: null,
        });
        transaction.update(refs.sessionRef, {
          agentRuntimeAuthorityState: "released",
          agentRuntimeBootHeartbeatAt: timestamp,
          agentRuntimeBootInstanceId: null,
        });
        logger.log?.(`released workspace runtime authority (${reason})`);
        return true;
      });
    } catch (error) {
      logger.warn?.("workspace runtime authority release failed", {
        workspaceId: config.workspaceId,
        sessionId: config.sessionId,
        reason,
        error: error.message || String(error),
      });
      throw normalizeAuthorityError(error);
    }
  }

  async function revokeForQa(reason = "qa_writer_revoked") {
    if (!enabled) throw authorityError("workspace_writer_authority_lost");
    if (!admitted) throw authorityError("workspace_writer_authority_lost");
    const refs = authorityRefs();
    await runAuthorityTransaction(async (transaction) => {
      const {workspace, session} = await readAuthority(transaction, refs);
      validateCurrent(workspace, session);
      const timestamp = serverTimestamp();
      transaction.update(refs.workspaceRef, {
        agentRuntimeAuthorityState: "released",
        agentRuntimeBootHeartbeatAt: timestamp,
        agentRuntimeBootInstanceId: null,
      });
      transaction.update(refs.sessionRef, {
        agentRuntimeAuthorityState: "released",
        agentRuntimeBootHeartbeatAt: timestamp,
        agentRuntimeBootInstanceId: null,
      });
    });
    const error = authorityError(reason);
    await loseAuthority(error);
    return {ok: true, reason};
  }

  function startRenewal() {
    stopRenewal();
    renewalTimer = setIntervalFn(() => {
      void renew().catch((error) => logger.warn?.("workspace runtime authority renewal failed", {
        workspaceId: config.workspaceId,
        sessionId: config.sessionId,
        error: error.message || String(error),
      }));
    }, renewalIntervalMs);
    renewalTimer?.unref?.();
  }

  function stopRenewal() {
    if (renewalTimer === null) return;
    clearIntervalFn(renewalTimer);
    renewalTimer = null;
  }

  async function loseAuthority(cause) {
    if (!admitted && lossReported) return;
    admitted = false;
    stopRenewal();
    if (lossReported) return;
    lossReported = true;
    const error = normalizeAuthorityError(cause);
    try {
      await onLost?.(error);
    } catch (onLostError) {
      logger.error?.("workspace runtime authority loss handler failed", onLostError);
    }
  }

  function status() {
    return {
      admitted: !enabled || admitted,
      bootInstanceId: enabled ? bootInstanceId : null,
      enabled,
      generation: positiveGeneration(config.agentRuntimeGeneration),
      sessionId: config.sessionId || null,
      workspaceId: config.workspaceId || null,
    };
  }

  function authorityRefs() {
    if (!db || typeof db.collection !== "function" || !config.workspaceId || !config.sessionId) {
      throw authorityError("workspace_runtime_coordination_unavailable");
    }
    const workspaceRef = db.collection("workspaces").doc(config.workspaceId);
    return {sessionRef: workspaceRef.collection("sessions").doc(config.sessionId), workspaceRef};
  }

  async function readAuthority(transaction, refs) {
    const workspaceSnap = await transaction.get(refs.workspaceRef);
    const sessionSnap = await transaction.get(refs.sessionRef);
    if (!workspaceSnap?.exists || !sessionSnap?.exists) {
      throw authorityError("workspace_runtime_coordination_missing");
    }
    return {session: sessionSnap.data() || {}, workspace: workspaceSnap.data() || {}};
  }

  async function runAuthorityTransaction(callback) {
    if (!db || typeof db.runTransaction !== "function") {
      throw authorityError("workspace_runtime_coordination_unavailable");
    }
    return db.runTransaction(callback);
  }

  function validateReservation(workspace, session) {
    if (workspace.agentUiVersion !== "pi-web-ui-v1" || session.agentUiVersion !== "pi-web-ui-v1") {
      throw authorityError("workspace_runtime_authority_denied");
    }
    const generation = positiveGeneration(config.agentRuntimeGeneration);
    if (!generation || positiveGeneration(workspace.agentRuntimeGeneration) !== generation || positiveGeneration(session.agentRuntimeGeneration) !== generation) {
      throw authorityError("workspace_runtime_generation_mismatch");
    }
    if (String(workspace.agentRuntimeSessionId || "").trim() !== String(config.sessionId)) {
      throw authorityError("workspace_runtime_authority_denied");
    }
    if (!ADMISSION_WORKSPACE_STATES.has(String(workspace.agentRuntimeState || "").trim().toLowerCase()) ||
      !ADMISSION_SESSION_STATES.has(String(session.status || "").trim().toLowerCase())) {
      throw authorityError("workspace_runtime_authority_denied");
    }
  }

  function validateCurrent(workspace, session) {
    validateReservation(workspace, session);
    if (!matchesCurrent(workspace, session) || String(workspace.agentRuntimeAuthorityState || "").trim().toLowerCase() !== "admitted") {
      throw authorityError("workspace_writer_authority_lost");
    }
  }

  function matchesCurrent(workspace, session) {
    return String(workspace.agentRuntimeBootInstanceId || "").trim() === bootInstanceId &&
      String(session.agentRuntimeBootInstanceId || "").trim() === bootInstanceId &&
      String(workspace.agentRuntimeSessionId || "").trim() === String(config.sessionId) &&
      positiveGeneration(workspace.agentRuntimeGeneration) === positiveGeneration(config.agentRuntimeGeneration) &&
      positiveGeneration(session.agentRuntimeGeneration) === positiveGeneration(config.agentRuntimeGeneration);
  }

  function serverTimestamp() {
    return admin?.firestore?.FieldValue?.serverTimestamp?.() || now();
  }
}

function positiveGeneration(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

function authorityError(code) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  return error;
}

function normalizeAuthorityError(error) {
  if (error?.code === "workspace_writer_authority_lost") return error;
  if (error?.code === "workspace_runtime_authority_denied") return error;
  if (error?.code === "workspace_runtime_generation_mismatch") return error;
  if (error?.code === "workspace_runtime_coordination_missing") return error;
  return authorityError("workspace_runtime_coordination_unavailable");
}

module.exports = {
  ADMISSION_SESSION_STATES,
  ADMISSION_WORKSPACE_STATES,
  createWorkspaceAuthority,
  positiveGeneration,
};
