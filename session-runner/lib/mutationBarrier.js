"use strict";

const DEFAULT_BARRIER_TIMEOUT_MS = 15_000;

/**
 * Coordinates the short mutation boundary used by strict checkpoints.
 *
 * The barrier only accounts for mutations that enter through a runner-owned
 * boundary. It deliberately does not claim to fence arbitrary processes in a
 * workspace; the process supervisor and checkpoint writer policy make that
 * limitation visible to callers.
 */
function createMutationBarrier({
  timeoutMs = DEFAULT_BARRIER_TIMEOUT_MS,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let state = "open";
  let reason = null;
  let sequence = 0;
  const active = new Map();
  const waiters = new Set();

  return {
    begin,
    block,
    close,
    enter,
    isOpen: () => state === "open",
    leave,
    reopen,
    snapshot,
    assertOpen,
    assertQuiescent,
    assertMutationAllowed: assertOpen,
    fence: (nextReason = "execution_authority_lost") => block(nextReason, "fenced"),
  };

  function assertOpen(label = "mutation") {
    if (state !== "open") throw barrierError(state === "fenced" ? "execution_authority_lost" : "checkpoint_barrier_pending", label);
    return true;
  }

  function assertQuiescent(label = "mutation") {
    assertOpen(label);
    if (active.size) throw barrierError("checkpoint_barrier_pending", label);
    return true;
  }

  function enter(label = "mutation") {
    assertOpen(label);
    const token = {id: ++sequence, label: String(label || "mutation"), startedAt: now()};
    active.set(token.id, token);
    return token;
  }

  function leave(token) {
    if (!token || !active.delete(token.id)) return false;
    if (!active.size) notifyWaiters();
    return true;
  }

  async function begin(options = {}) {
    if (state === "fenced") throw barrierError("execution_authority_lost", options.reason || "checkpoint");
    if (state !== "open") throw barrierError("checkpoint_barrier_pending", options.reason || "checkpoint");
    state = "closing";
    reason = String(options.reason || "checkpoint").slice(0, 128);
    const waitMs = positive(options.timeoutMs, timeoutMs);
    if (!active.size) {
      state = "closed";
      return snapshot();
    }

    await new Promise((resolve, reject) => {
      const waiter = {resolve, reject};
      const timer = setTimeoutFn(() => {
        waiters.delete(waiter);
        state = "blocked";
        notifyWaiters();
        const error = barrierError("checkpoint_barrier_timeout", reason);
        error.active = [...active.values()].map((entry) => ({...entry}));
        reject(error);
      }, waitMs);
      waiter.timer = timer;
      waiters.add(waiter);
    });
    if (active.size) {
      state = "blocked";
      throw barrierError("checkpoint_barrier_timeout", reason);
    }
    state = "closed";
    return snapshot();
  }

  function close(options = {}) {
    return begin(options);
  }

  function reopen() {
    if (state === "fenced") return false;
    state = "open";
    reason = null;
    return true;
  }

  function block(nextReason = "checkpoint_failed", nextState = "blocked") {
    if (nextState === "fenced") state = "fenced";
    else if (state !== "fenced") state = "blocked";
    reason = String(nextReason || "checkpoint_failed").slice(0, 128);
    notifyWaiters();
    return snapshot();
  }

  function notifyWaiters() {
    if (active.size && state === "closing") return;
    for (const waiter of waiters) {
      clearTimeoutFn(waiter.timer);
      waiter.resolve();
    }
    waiters.clear();
  }

  function snapshot() {
    return {
      state,
      reason,
      activeCount: active.size,
      active: [...active.values()].map((entry) => ({...entry})),
      updatedAt: now(),
    };
  }
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function barrierError(code, label) {
  const error = new Error(code);
  error.code = code;
  error.label = String(label || "mutation").slice(0, 128);
  return error;
}

module.exports = {
  DEFAULT_BARRIER_TIMEOUT_MS,
  createMutationBarrier,
};
