"use strict";

const {randomUUID: defaultRandomUUID} = require("node:crypto");

const QA_FAULT_HARNESS_ID = "pi-web-failure-recovery-v1";
const QA_FAULTS = Object.freeze([
  "storage-publication",
  "writer-revocation",
  "uncertain-replacement",
  "no-auto-resume",
  "short-lived-access",
]);
const ACCESS_TTL_MIN_MS = 1_000;
const ACCESS_TTL_MAX_MS = 60_000;

/**
 * A disposable-only fault controller for the hosted pi-web lifecycle case.
 *
 * The controller is deliberately stateful in Firestore: one-shot faults must
 * survive a runner restart and must be consumed transactionally so a retry
 * cannot inject the same failure twice. It is enabled only when both the
 * server-owned managed runtime marker and the explicit QA case environment
 * value are present.
 */
function createQaFaultHarness({
  config = {},
  db,
  now = () => new Date().toISOString(),
  processImpl = process,
  randomUUID = defaultRandomUUID,
  setTimeoutImpl = setTimeout,
  workspaceAuthority,
} = {}) {
  const enabled = config.agentRuntimeEnabled === true &&
    config.qaFaultHarness === QA_FAULT_HARNESS_ID &&
    config.qaCase === "pi-web-failure-recovery";

  return {
    arm,
    consume,
    enabled: () => enabled,
    forceLoss,
    revokeWriter,
    reset,
    status,
  };

  async function arm(fault, options = {}) {
    assertEnabled();
    const name = normalizeFault(fault);
    const state = await updateState((current) => {
      const armed = {...current.armed};
      if (name === "short-lived-access") {
        armed[name] = {
          ttlMs: normalizeAccessTtl(options.ttlMs),
          armedAt: now(),
        };
        return {
          ...current,
          armed,
          accessRenewalTtlMs: armed[name].ttlMs,
          updatedAt: now(),
        };
      } else {
        armed[name] = {remaining: 1, armedAt: now()};
      }
      return {...current, armed, updatedAt: now()};
    });
    return safeStatus(state);
  }

  async function consume(fault) {
    assertEnabled();
    const name = normalizeFault(fault);
    if (name === "short-lived-access") return false;
    const result = await updateState((current) => {
      const armedEntry = current.armed[name];
      if (!armedEntry || Number(armedEntry.remaining || 0) < 1) return {state: current, consumed: false};
      const armed = {...current.armed};
      delete armed[name];
      const consumed = {
        ...current.consumed,
        [name]: {consumedAt: now(), id: randomUUID()},
      };
      return {state: {...current, armed, consumed, updatedAt: now()}, consumed: true};
    }, {returnResult: true});
    return Boolean(result.consumed);
  }

  async function revokeWriter() {
    assertEnabled();
    const consumed = await consume("writer-revocation");
    if (!consumed) throw qaError("qa_fault_not_armed", "writer-revocation is not armed");
    if (typeof workspaceAuthority?.revokeForQa !== "function") {
      throw qaError("qa_fault_unavailable", "writer revocation is unavailable");
    }
    await workspaceAuthority.revokeForQa("qa_writer_revoked");
    return {ok: true, fault: "writer-revocation", state: "revoked"};
  }

  async function forceLoss() {
    assertEnabled();
    const consumed = await consume("no-auto-resume");
    if (!consumed) throw qaError("qa_fault_not_armed", "no-auto-resume is not armed");
    if (typeof workspaceAuthority?.release === "function") {
      await workspaceAuthority.release("qa_forced_loss");
    }
    const kill = processImpl && typeof processImpl.kill === "function" ? processImpl.kill.bind(processImpl) : null;
    if (!kill || !processImpl.pid) throw qaError("qa_fault_unavailable", "forced loss is unavailable");
    setTimeoutImpl(() => kill(processImpl.pid, "SIGKILL"), 25).unref?.();
    return {ok: true, fault: "no-auto-resume", state: "forced-loss-scheduled"};
  }

  async function reset() {
    assertEnabled();
    const state = await updateState((current) => ({
      id: QA_FAULT_HARNESS_ID,
      version: 1,
      armed: {},
      consumed: current.consumed || {},
      accessRenewalTtlMs: null,
      updatedAt: now(),
    }));
    return safeStatus(state);
  }

  async function status() {
    if (!enabled) return {enabled: false, id: QA_FAULT_HARNESS_ID};
    const state = await readState();
    return safeStatus(state);
  }

  async function readState() {
    const snapshot = await sessionRef().get();
    return normalizeState(snapshot.exists ? snapshot.data()?.qaFaultHarness : null);
  }

  async function updateState(mutator, {returnResult = false} = {}) {
    if (!db || typeof db.runTransaction !== "function") {
      throw qaError("qa_fault_coordination_unavailable", "QA fault coordination is unavailable");
    }
    let result;
    await db.runTransaction(async (transaction) => {
      const ref = sessionRef();
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw qaError("qa_fault_session_missing", "QA fault session is missing");
      const current = normalizeState(snapshot.data()?.qaFaultHarness);
      const next = mutator(current);
      if (next && next.state) {
        result = next;
        transaction.update(ref, {qaFaultHarness: next.state});
      } else {
        result = {state: next, consumed: false};
        transaction.update(ref, {qaFaultHarness: next});
      }
    });
    return returnResult ? result : result.state || result;
  }

  function sessionRef() {
    if (!db || typeof db.collection !== "function" || !config.workspaceId || !config.sessionId) {
      throw qaError("qa_fault_coordination_unavailable", "QA fault session identity is unavailable");
    }
    return db.collection("workspaces").doc(config.workspaceId).collection("sessions").doc(config.sessionId);
  }

  function assertEnabled() {
    if (!enabled) throw qaError("qa_fault_harness_unavailable", "QA fault harness is unavailable");
  }
}

function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    id: QA_FAULT_HARNESS_ID,
    version: 1,
    armed: state.armed && typeof state.armed === "object" ? state.armed : {},
    consumed: state.consumed && typeof state.consumed === "object" ? state.consumed : {},
    accessRenewalTtlMs: state.accessRenewalTtlMs || null,
    updatedAt: state.updatedAt || null,
  };
}

function safeStatus(state) {
  return {
    enabled: true,
    id: QA_FAULT_HARNESS_ID,
    supportedFaults: [...QA_FAULTS],
    armed: Object.fromEntries(Object.entries(state.armed || {}).map(([fault, value]) => [fault, {
      ttlMs: value?.ttlMs || undefined,
      remaining: value?.remaining || undefined,
    }])),
    consumed: Object.keys(state.consumed || {}),
    accessRenewalTtlMs: state.accessRenewalTtlMs || null,
    updatedAt: state.updatedAt || null,
  };
}

function normalizeFault(value) {
  const fault = String(value || "").trim().toLowerCase();
  if (!QA_FAULTS.includes(fault)) throw qaError("qa_fault_unknown", `Unknown QA fault: ${fault || "(empty)"}`);
  return fault;
}

function normalizeAccessTtl(value) {
  const ttlMs = Number(value || 3_000);
  if (!Number.isFinite(ttlMs)) return 3_000;
  return Math.max(ACCESS_TTL_MIN_MS, Math.min(ACCESS_TTL_MAX_MS, Math.floor(ttlMs)));
}

function qaError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = code === "qa_fault_harness_unavailable" ? 404 : 409;
  return error;
}

module.exports = {
  ACCESS_TTL_MAX_MS,
  ACCESS_TTL_MIN_MS,
  QA_FAULT_HARNESS_ID,
  QA_FAULTS,
  createQaFaultHarness,
  normalizeAccessTtl,
  normalizeFault,
};
