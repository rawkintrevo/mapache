"use strict";

const fs = require("node:fs");

const DEFAULT_WORKSPACE_INTERVAL_MS = 30_000;
const DEFAULT_AGENT_INTERVAL_MS = 60_000;
const DEFAULT_COMPLETED_TURN_DEBOUNCE_MS = 1_000;
const DEFAULT_ACTIVITY_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MANUAL_SAVE_BUDGET_MS = 120_000;

/**
 * Serializes workspace and agent checkpoint work for one runner.
 *
 * Workspace sync already serializes remote workspace writes, but it cannot
 * serialize those writes with local agent-state capture. This queue is the
 * single lifecycle owner for periodic, completed-turn, and final saves.
 */
function createAgentCheckpointScheduler({
  agentSnapshot,
  checkpointIdentity,
  checkpointPublisher,
  config = {},
  clearIntervalImpl = clearInterval,
  clearTimeoutImpl = clearTimeout,
  fsImpl = fs,
  logger = console,
  now = () => Date.now(),
  piModelScope,
  piWebUi,
  setIntervalImpl = setInterval,
  setTimeoutImpl = setTimeout,
  workspaceSync,
} = {}) {
  const agentEnabled = config.agentRuntimeEnabled === true || config.agentUiVersion === "pi-web-ui-v1";
  const workspaceIntervalMs = positiveNumber(config.syncIntervalMs, DEFAULT_WORKSPACE_INTERVAL_MS);
  const agentIntervalMs = positiveNumber(config.agentSnapshotIntervalMs, DEFAULT_AGENT_INTERVAL_MS);
  const turnDebounceMs = positiveNumber(config.agentCompletedTurnDebounceMs, DEFAULT_COMPLETED_TURN_DEBOUNCE_MS);
  const activityPollIntervalMs = positiveNumber(config.agentActivityPollIntervalMs, DEFAULT_ACTIVITY_POLL_INTERVAL_MS);
  const manualSaveBudgetMs = positiveNumber(config.manualSaveBudgetMs, DEFAULT_MANUAL_SAVE_BUDGET_MS);

  let workspaceTimer = null;
  let agentTimer = null;
  let activityTimer = null;
  let turnTimer = null;
  let started = false;
  let accepting = false;
  let queueTail = Promise.resolve();
  const pending = new Map();
  let finalPromise = null;
  let finalInFlight = false;
  let completedTurnsSeen = null;
  let activityPollInFlight = null;
  let lastArchiveSyncAt = 0;
  let lastWorkspaceSaveAt = null;
  let lastAgentSaveAt = null;
  let lastError = null;

  return {
    start,
    stop,
    noteCompletedTurn,
    flush,
    finalize,
    status,
  };

  function start() {
    if (started) return status();
    started = true;
    accepting = true;
    workspaceTimer = setIntervalImpl(() => {
      runQueued("workspace-periodic", () => saveWorkspace({final: false}), "workspace periodic save");
    }, workspaceIntervalMs);
    workspaceTimer?.unref?.();

    if (agentEnabled) {
      agentTimer = setIntervalImpl(() => {
        runQueued("agent-periodic", () => saveAgent({final: false}), "agent periodic save");
      }, agentIntervalMs);
      agentTimer?.unref?.();
      if (typeof piWebUi?.activity === "function") {
        activityTimer = setIntervalImpl(() => {
          pollCompletedTurns().catch((error) => {
            logger.warn?.("pi-web-ui activity poll failed", safeError(error));
          });
        }, activityPollIntervalMs);
        activityTimer?.unref?.();
        void pollCompletedTurns();
      }
    }
    return status();
  }

  function stop() {
    if (workspaceTimer !== null) clearIntervalImpl(workspaceTimer);
    if (agentTimer !== null) clearIntervalImpl(agentTimer);
    if (activityTimer !== null) clearIntervalImpl(activityTimer);
    if (turnTimer !== null) clearTimeoutImpl(turnTimer);
    workspaceTimer = null;
    agentTimer = null;
    activityTimer = null;
    turnTimer = null;
    started = false;
    accepting = false;
    return status();
  }

  function noteCompletedTurn() {
    if (!agentEnabled || !accepting) return;
    if (turnTimer !== null) clearTimeoutImpl(turnTimer);
    turnTimer = setTimeoutImpl(() => {
      turnTimer = null;
      runQueued("agent-turn", () => saveAgent({final: false}), "completed-turn agent save");
    }, turnDebounceMs);
    turnTimer?.unref?.();
  }

  async function pollCompletedTurns() {
    if (!agentEnabled || activityPollInFlight || typeof piWebUi?.activity !== "function") return;
    activityPollInFlight = Promise.resolve().then(() => piWebUi.activity()).then((activity) => {
      const count = integerOrNull(activity?.completedTurns);
      if (count === null) return;
      if (completedTurnsSeen === null) {
        completedTurnsSeen = count;
        return;
      }
      if (count < completedTurnsSeen) {
        // The child was replaced or its in-memory status reset. Do not infer a
        // completed turn from a counter reset; the next increase is enough.
        completedTurnsSeen = count;
        return;
      }
      if (count > completedTurnsSeen) {
        completedTurnsSeen = count;
        noteCompletedTurn();
      }
    }).catch((error) => {
      logger.warn?.("pi-web-ui completed-turn poll failed", safeError(error));
    }).finally(() => {
      activityPollInFlight = null;
    });
    await activityPollInFlight;
  }

  function runQueued(key, operation, label) {
    const existing = pending.get(key);
    if (existing) return existing;
    const run = queueTail.catch(() => {}).then(async () => {
      try {
        const result = await operation();
        if (key.startsWith("workspace")) lastWorkspaceSaveAt = now();
        if (key.startsWith("agent")) lastAgentSaveAt = now();
        lastError = null;
        return result;
      } catch (error) {
        lastError = {code: error?.code || "checkpoint_failed", label, at: now()};
        logger.error?.(`${label} failed`, safeError(error));
        throw error;
      }
    });
    const settled = run.finally(() => {
      if (pending.get(key) === settled) pending.delete(key);
    });
    pending.set(key, settled);
    queueTail = settled.catch(() => {});
    return settled;
  }

  async function flush({timeoutMs} = {}) {
    const wait = queueTail;
    if (timeoutMs === undefined) return wait;
    return bounded(wait, now() + positiveNumber(timeoutMs, manualSaveBudgetMs), "checkpoint_timeout");
  }

  async function finalize({timeoutMs = manualSaveBudgetMs} = {}) {
    stop();
    if (finalPromise) return finalPromise;
    const deadline = now() + positiveNumber(timeoutMs, manualSaveBudgetMs);
    finalInFlight = true;
    finalPromise = bounded(runQueued("final", async () => {
      const failures = [];
      try {
        await bounded(Promise.resolve(workspaceSync?.flush?.()), deadline, "checkpoint_timeout");
      } catch (error) {
        failures.push(error);
      }
      try {
        await bounded(Promise.resolve(piModelScope?.persist?.()), deadline, "checkpoint_timeout");
      } catch (error) {
        failures.push(error);
      }
      if (agentEnabled) {
        try {
          await saveAgent({final: true, deadline});
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await saveWorkspace({final: true, deadline, persistModel: false});
      } catch (error) {
        failures.push(error);
      }
      try {
        await bounded(Promise.resolve(workspaceSync?.flush?.()), deadline, "checkpoint_timeout");
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw failures[0];
      return {ok: true, final: true};
    }, "final checkpoint save"), deadline, "checkpoint_timeout").catch((error) => {
      lastError = {code: error?.code || "checkpoint_timeout", label: "final checkpoint save", at: now()};
      throw error;
    }).finally(() => {
      finalInFlight = false;
    });
    return finalPromise;
  }

  async function saveWorkspace({final, deadline, persistModel = true} = {}) {
    const includeArchives = Boolean(final) || now() - lastArchiveSyncAt >= positiveNumber(config.archiveSyncIntervalMs, 300_000);
    if (persistModel) {
      await bounded(Promise.resolve(piModelScope?.persist?.()), deadline, "checkpoint_timeout");
    }
    const result = await bounded(
        workspaceSync?.syncUp?.({includeArchives}) || Promise.resolve({conflicts: []}),
        deadline,
        "checkpoint_timeout",
    );
    if (includeArchives) lastArchiveSyncAt = now();
    return result;
  }

  async function saveAgent({final, deadline} = {}) {
    if (!agentEnabled) return {enabled: false, skipped: true};
    const identity = typeof checkpointIdentity === "function" ? checkpointIdentity() || {} : {};
    let capture;
    try {
      capture = await bounded(agentSnapshot.capture({
        ...identity,
        bootInstanceId: identity.bootInstanceId || config.agentRuntimeBootInstanceId,
        generation: identity.generation || config.agentRuntimeGeneration,
      }), deadline, "checkpoint_timeout");
      const uploaded = await bounded(checkpointPublisher.uploadCapture(capture), deadline, "checkpoint_timeout");
      return await bounded(checkpointPublisher.commitCheckpoint(uploaded), deadline, "checkpoint_timeout");
    } catch (error) {
      try {
        await checkpointPublisher.recordCheckpointError?.(error?.code || "checkpoint_agent_save_failed", identity);
      } catch (statusError) {
        logger.warn?.("agent checkpoint error status failed", safeError(statusError));
      }
      throw error;
    } finally {
      if (capture?.stagingDir) await fsImpl.promises.rm(capture.stagingDir, {recursive: true, force: true}).catch(() => {});
    }
  }

  function bounded(value, deadline, code) {
    if (deadline === undefined || deadline === null) return value;
    const remaining = Math.max(1, deadline - now());
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeoutImpl(() => {
        const error = new Error(code);
        error.code = code;
        reject(error);
      }, remaining);
      timer?.unref?.();
    });
    return Promise.race([value, timeout]).finally(() => {
      if (timer !== undefined) clearTimeoutImpl(timer);
    });
  }

  function status() {
    return {
      enabled: true,
      agentEnabled,
      running: started,
      queueDepth: pending.size,
      active: pending.size > 0,
      finalInFlight,
      lastWorkspaceSaveAt,
      lastAgentSaveAt,
      lastError: lastError ? {...lastError} : null,
      completedTurnsSeen,
    };
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function integerOrNull(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeError(error) {
  return String(error?.message || error || "unknown_error").replace(/\s+/g, " ").slice(0, 240);
}

module.exports = {
  createAgentCheckpointScheduler,
};
