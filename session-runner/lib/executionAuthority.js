"use strict";

const crypto = require("node:crypto");

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RENEW_INTERVAL_MS = 10_000;

/**
 * Firestore-backed execution authority for the opt-in pi-chrome web-first
 * runner. The existing sync-writer reservation is checked in every authority
 * transaction; this is not a second, unrelated workspace lock.
 */
function createExecutionAuthority({
  admin,
  db,
  config = {},
  runtimeId = `runtime-${crypto.randomUUID()}`,
  leaseMs = DEFAULT_LEASE_MS,
  renewIntervalMs = DEFAULT_RENEW_INTERVAL_MS,
  clock = {},
  timers = globalThis,
  onLost,
  logger = console,
} = {}) {
  const wallNow = clock.now || (() => Date.now());
  const monotonicNow = clock.monotonic || (() => Number(process.hrtime.bigint() / 1000000n));
  const enabled = Boolean(config.webFirstEnabled);
  const workspaceId = String(config.workspaceId || "").trim();
  const sessionId = String(config.sessionId || "").trim();
  const effectiveLeaseMs = positive(leaseMs, DEFAULT_LEASE_MS);
  const effectiveRenewIntervalMs = Math.min(
      positive(renewIntervalMs, DEFAULT_RENEW_INTERVAL_MS),
      Math.max(1000, effectiveLeaseMs - 1),
  );
  let state = enabled ? "unowned" : "disabled";
  let executionEpoch = null;
  let confirmedDeadline = null;
  let timer = null;
  let renewalInFlight = null;
  let lossPromise = null;
  let lastError = null;
  let started = false;

  return {
    acquire,
    assertAuthority,
    canMutate: () => {
      if (!enabled) return true;
      const allowed = state === "owned" && !isExpired();
      if (!allowed && state === "owned" && isExpired()) void fence("local_deadline_expired");
      return allowed;
    },
    enabled,
    fence,
    release,
    snapshot,
    start,
    renew,
    isOwner: () => state === "owned" && !isExpired(),
  };

  async function start() {
    if (!enabled || started) return snapshot();
    started = true;
    try {
      await acquire();
    } catch (error) {
      lastError = safeError(error);
      state = error.code === "execution_recovery_required" ? "recovery_required" : "unavailable";
      logger.warn?.("web-first execution authority unavailable", {code: error.code, error: lastError});
    }
    if (state === "owned") scheduleRenewal();
    return snapshot();
  }

  async function acquire() {
    if (!enabled) return snapshot();
    requireIdentity();
    const refs = authorityRefs();
    let acquired;
    await db.runTransaction(async (transaction) => {
      const workspaceSnap = await transaction.get(refs.workspaceRef);
      const sessionSnap = await transaction.get(refs.sessionRef);
      if (!workspaceSnap.exists || !sessionSnap.exists) throw authorityError("execution_workspace_missing");
      const workspace = workspaceSnap.data() || {};
      const session = sessionSnap.data() || {};
      assertWriterReservation(workspace, session);
      const current = workspace.executionAuthority || {};
      if (["active", "fenced", "recovery_required"].includes(String(current.state || "")) &&
          String(current.runtimeId || "") !== runtimeId) {
        throw authorityError("execution_recovery_required", {
          predecessorRuntimeId: String(current.runtimeId || "") || null,
          predecessorExecutionEpoch: Number(current.executionEpoch || 0) || null,
        });
      }
      executionEpoch = Math.max(1, Number(current.executionEpoch || 0) + 1);
      const deadline = wallNow() + effectiveLeaseMs;
      const record = authorityRecord({deadline, state: "active"});
      transaction.set(refs.workspaceRef, {executionAuthority: record}, {merge: true});
      transaction.set(refs.sessionRef, {executionAuthority: record}, {merge: true});
      acquired = record;
    });
    state = "owned";
    confirmedDeadline = monotonicNow() + effectiveLeaseMs;
    lastError = null;
    return {...snapshot(), authority: acquired};
  }

  async function renew() {
    if (!enabled || state !== "owned") throw authorityError("execution_authority_lost");
    if (isExpired()) {
      await fence("renewal_deadline_expired");
      throw authorityError("execution_authority_lost");
    }
    if (renewalInFlight) return renewalInFlight;
    renewalInFlight = (async () => {
      const refs = authorityRefs();
      const deadline = wallNow() + effectiveLeaseMs;
      await db.runTransaction(async (transaction) => {
        const workspaceSnap = await transaction.get(refs.workspaceRef);
        const sessionSnap = await transaction.get(refs.sessionRef);
        const workspace = workspaceSnap.exists ? workspaceSnap.data() || {} : {};
        const session = sessionSnap.exists ? sessionSnap.data() || {} : {};
        assertWriterReservation(workspace, session);
        assertCurrentAuthority(workspace.executionAuthority);
        const record = authorityRecord({deadline, state: "active"});
        transaction.set(refs.workspaceRef, {executionAuthority: record}, {merge: true});
        transaction.set(refs.sessionRef, {executionAuthority: record}, {merge: true});
      });
      if (isExpired()) {
        await fence("renewal_confirmed_after_deadline");
        throw authorityError("execution_authority_lost");
      }
      confirmedDeadline = monotonicNow() + effectiveLeaseMs;
      lastError = null;
      return snapshot();
    })().catch(async (error) => {
      lastError = safeError(error);
      await fence("renewal_unconfirmed");
      throw error;
    }).finally(() => {
      renewalInFlight = null;
    });
    return renewalInFlight;
  }

  async function release(reason = "runner_shutdown") {
    if (!enabled || state === "disabled" || state === "released") return snapshot();
    stopRenewal();
    if (state !== "owned") return snapshot();
    const refs = authorityRefs();
    try {
      await db.runTransaction(async (transaction) => {
        const workspaceSnap = await transaction.get(refs.workspaceRef);
        if (!workspaceSnap.exists) return;
        const current = workspaceSnap.data()?.executionAuthority;
        if (!sameAuthority(current)) return;
        const record = authorityRecord({deadline: wallNow(), state: "released", reason});
        transaction.set(refs.workspaceRef, {executionAuthority: record}, {merge: true});
        transaction.set(refs.sessionRef, {executionAuthority: record}, {merge: true});
      });
      state = "released";
      confirmedDeadline = null;
    } catch (error) {
      lastError = safeError(error);
      await fence("release_unconfirmed");
    }
    return snapshot();
  }

  async function fence(reason = "execution_authority_lost") {
    if (!enabled || state === "disabled" || state === "fenced") return lossPromise || snapshot();
    stopRenewal();
    state = "fenced";
    confirmedDeadline = null;
    lastError = String(reason || "execution_authority_lost").slice(0, 256);
    const refs = authorityRefs();
    lossPromise = Promise.resolve().then(async () => {
      try {
        await db.runTransaction(async (transaction) => {
          const workspaceSnap = await transaction.get(refs.workspaceRef);
          if (!workspaceSnap.exists || !sameAuthority(workspaceSnap.data()?.executionAuthority)) return;
          const record = authorityRecord({deadline: wallNow(), state: "fenced", reason});
          transaction.set(refs.workspaceRef, {executionAuthority: record}, {merge: true});
          transaction.set(refs.sessionRef, {executionAuthority: record}, {merge: true});
        });
      } catch (error) {
        logger.error?.("execution authority fence write failed", safeError(error));
      }
      await onLost?.({reason: String(reason || "execution_authority_lost"), runtimeId, executionEpoch});
      return snapshot();
    });
    return lossPromise;
  }

  function assertAuthority() {
    if (!enabled) return true;
    if (state !== "owned" || isExpired()) {
      if (state === "owned") void fence("local_deadline_expired");
      throw authorityError("execution_authority_lost");
    }
    return true;
  }

  function scheduleRenewal() {
    stopRenewal();
    timer = timers.setTimeout(async () => {
      timer = null;
      if (state !== "owned") return;
      if (isExpired()) {
        await fence("local_deadline_expired");
        return;
      }
      try {
        await renew();
      } catch (error) {
        logger.warn?.("web-first execution renewal failed", {code: error.code, error: safeError(error)});
        return;
      }
      if (state === "owned") scheduleRenewal();
    }, effectiveRenewIntervalMs);
    timer?.unref?.();
  }

  function stopRenewal() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  function isExpired() {
    return confirmedDeadline !== null && monotonicNow() >= confirmedDeadline;
  }

  function snapshot() {
    return {
      enabled,
      state,
      runtimeId,
      executionEpoch,
      leaseMs: effectiveLeaseMs,
      renewIntervalMs: effectiveRenewIntervalMs,
      confirmedDeadline,
      expired: isExpired(),
      lastError,
      renewing: Boolean(renewalInFlight),
    };
  }

  function authorityRefs() {
    return {
      workspaceRef: db.collection("workspaces").doc(workspaceId),
      sessionRef: db.collection("workspaces").doc(workspaceId).collection("sessions").doc(sessionId),
    };
  }

  function authorityRecord({deadline, state: nextState, reason: nextReason} = {}) {
    return {
      schemaVersion: 1,
      runtimeId,
      sessionId,
      executionEpoch,
      state: nextState,
      leaseDeadlineMs: Number(deadline),
      leaseMs: effectiveLeaseMs,
      ...(nextReason ? {reason: String(nextReason).slice(0, 256)} : {}),
      updatedAt: admin?.firestore?.FieldValue?.serverTimestamp?.() || new Date(wallNow()),
    };
  }

  function assertWriterReservation(workspace, session) {
    if (String(session.syncWriterRole || "") !== "writer" ||
        String(workspace.syncWriterSessionId || "") !== sessionId ||
        !session.syncWriterLeaseId ||
        String(workspace.syncWriterLeaseId || "") !== String(session.syncWriterLeaseId)) {
      throw authorityError("execution_writer_reservation_required");
    }
  }

  function assertCurrentAuthority(current = {}) {
    if (!sameAuthority(current) || String(current.state || "") !== "active") {
      throw authorityError("execution_authority_lost");
    }
  }

  function sameAuthority(current = {}) {
    return String(current.runtimeId || "") === runtimeId &&
      Number(current.executionEpoch || 0) === Number(executionEpoch) &&
      String(current.sessionId || "") === sessionId;
  }

  function requireIdentity() {
    if (!db || typeof db.runTransaction !== "function" || typeof db.collection !== "function") {
      throw authorityError("execution_authority_store_unavailable");
    }
    if (!workspaceId || !sessionId) throw authorityError("execution_identity_missing");
  }
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeError(error) {
  return String(error && (error.code || error.message) || error || "unknown_error").slice(0, 512);
}

function authorityError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

module.exports = {
  DEFAULT_LEASE_MS,
  DEFAULT_RENEW_INTERVAL_MS,
  createExecutionAuthority,
};
