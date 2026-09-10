"use strict";

const DEFAULT_STOP_TIMEOUT_MS = 5000;

/**
 * Tracks runner-owned child handles so an authority loss has one bounded stop
 * boundary. Registration is explicit: arbitrary detached processes are not
 * silently treated as controlled work.
 */
function createProcessSupervisor({
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  const children = new Map();
  let fenced = false;

  return {
    fence,
    register,
    snapshot,
    stopAll,
  };

  function register(child, options = {}) {
    if (!child) return () => {};
    const id = String(options.id || `child-${child.pid || Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const entry = {
      id,
      label: String(options.label || id).slice(0, 128),
      child,
      pid: Number(child.pid || 0) || null,
      startedAt: Date.now(),
    };
    children.set(id, entry);
    const remove = () => {
      if (children.get(id) === entry) children.delete(id);
    };
    if (typeof child.once === "function") {
      child.once("exit", remove);
      child.once("close", remove);
    } else child.onExit?.(remove);
    return remove;
  }

  function fence() {
    fenced = true;
    return snapshot();
  }

  async function stopAll(reason = "execution_authority_lost") {
    const entries = [...children.values()];
    const unresolved = [];
    await Promise.all(entries.map(async (entry) => {
      try {
        if (typeof entry.child.kill === "function") entry.child.kill("SIGTERM");
        await waitForExit(entry.child, stopTimeoutMs);
      } catch (error) {
        unresolved.push({id: entry.id, label: entry.label, pid: entry.pid, error: String(error.message || error)});
      }
    }));
    if (unresolved.length) {
      logger.error?.("controlled child termination unresolved", {reason, children: unresolved});
      const error = new Error("execution_child_termination_unresolved");
      error.code = "execution_child_termination_unresolved";
      error.children = unresolved;
      throw error;
    }
    return snapshot();
  }

  function snapshot() {
    return {
      fenced,
      count: children.size,
      children: [...children.values()].map((entry) => ({
        id: entry.id,
        label: entry.label,
        pid: entry.pid,
        startedAt: entry.startedAt,
      })),
    };
  }

  function waitForExit(child, timeoutMs) {
    if (child.exitCode !== undefined && child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        child.off?.("exit", onExit);
        child.off?.("close", onExit);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => finish();
      const timer = setTimeoutFn(() => {
        const error = new Error("execution_child_stop_timeout");
        error.code = "execution_child_stop_timeout";
        finish(error);
      }, timeoutMs);
      if (typeof child.once === "function") {
        child.once("exit", onExit);
        child.once("close", onExit);
      } else if (typeof child.onExit === "function") child.onExit(onExit);
    });
  }
}

module.exports = {
  DEFAULT_STOP_TIMEOUT_MS,
  createProcessSupervisor,
};
