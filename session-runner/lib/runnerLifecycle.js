"use strict";

function createRunnerLifecycleCoordinator({
  activity,
  activeHarness,
  admin,
  chromeProfile,
  chromeProfileSnapshots,
  chromeRuntime,
  checkpointScheduler,
  config,
  git,
  listen,
  logger = console,
  piWebUi,
  resourceMetrics,
  piModelScope,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now(),
  workspace,
  workspaceAuthority,
  workspaceSync,
}) {
  const authority = workspaceAuthority || {
    acquire: async () => {},
    assertCurrentWriter: async () => true,
    isCurrentWriter: () => true,
    release: async () => false,
  };
  let shutdownInFlight = null;

  async function start() {
    try {
      await workspace.ensureWorkspace();
      logger.log(`workspace source mode: ${config.workspaceSourceMode}, sync role: ${config.workspaceSyncRole}, sync policy mode: ${config.workspaceSyncPolicyMode}`);
      await workspace.prepareWorkspaceSource();
      await git.prepareSharedWorkspaceGit?.();
      await workspace.restoreCheckpoint?.();
      await authority.acquire();
      await activity.updateSessionActivity({
        runtimeStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await piModelScope.restore();
      await chromeProfile.restore();
      await chromeRuntime.start();
      await activeHarness.materializeConfig();
      await activeHarness.materializeAuth();
      await git.prepareGithubAutomationBranch();
      await activeHarness.materializeMcp();
      await activeHarness.materializeSkills();
      if (config.agentRuntimeEnabled) await piWebUi.start();
      chromeProfileSnapshots.start();
      if (checkpointScheduler) checkpointScheduler.start();
      else startSyncLoop();
      listen(() => {
        logger.log(`session runner listening on ${config.port}`);
      });
    } catch (error) {
      await authority.release("startup_failed").catch((releaseError) => {
        logger.error("workspace runtime authority release failed after startup error", releaseError);
      });
      await activity.markRuntimeStartupFailure(error).catch((writeError) => {
        logger.error("session runtime failure write failed", writeError);
      });
      throw error;
    }
  }

  async function shutdown() {
    return shutdownWithBudget({reason: "manual", budgetMs: config.manualSaveBudgetMs || 120_000});
  }

  async function shutdownWithBudget({reason, budgetMs}) {
    if (shutdownInFlight) return shutdownInFlight;
    shutdownInFlight = shutdownInternal({reason, budgetMs}).finally(() => {
      shutdownInFlight = null;
    });
    return shutdownInFlight;
  }

  async function shutdownInternal({reason, budgetMs}) {
    const deadline = now() + Math.max(1, Number(budgetMs) || 120_000);
    checkpointScheduler?.stop?.();
    try {
      if (config.agentRuntimeEnabled) {
        try {
          await piWebUi?.quiesce?.();
        } catch (error) {
          // A stalled cooperative drain must not prevent process-group
          // escalation. piWebUi.stop() confirms the child has exited before
          // the rest of shutdown can touch shared workspace state.
          logger.warn?.("pi-web-ui quiesce failed; escalating to process-group stop", error);
        }
        await piWebUi?.stop?.();
      }
      resourceMetrics?.close?.();
      await chromeRuntime.stop();
      if (!checkpointScheduler) {
        await piModelScope.persist().catch((error) => logger.error("Pi model scope sync failed during shutdown", error));
      }
      if (chromeProfileSnapshots.enabled()) {
        await chromeProfileSnapshots.stop();
        if (authority.isCurrentWriter()) await bounded(chromeProfileSnapshots.finalize(), deadline, "checkpoint_timeout");
        else logger.warn?.("final Chrome profile snapshot skipped after writer authority loss");
      } else if (checkpointScheduler) {
        await bounded(checkpointScheduler.finalize({timeoutMs: Math.max(1, deadline - now())}), deadline, "checkpoint_timeout");
      } else if (authority.isCurrentWriter()) {
        await bounded(workspaceSync.syncUp({includeArchives: true}), deadline, "checkpoint_timeout");
      } else {
        logger.warn?.("final workspace sync skipped after writer authority loss");
      }
      if (checkpointScheduler && chromeProfileSnapshots.enabled()) {
        await bounded(checkpointScheduler.finalize({timeoutMs: Math.max(1, deadline - now())}), deadline, "checkpoint_timeout");
      }
      await activity.updateSessionActivity({
        lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
        shutdownRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } finally {
      await authority.release("shutdown").catch((error) => {
        logger.error("workspace runtime authority release failed during shutdown", error);
      });
    }
  }

  function bounded(value, deadline, code) {
    const remaining = Math.max(1, deadline - now());
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeoutFn(() => {
        const error = new Error(code);
        error.code = code;
        reject(error);
      }, remaining);
    });
    return Promise.race([value, timeout]).finally(() => {
      if (timer !== undefined) clearTimeoutFn(timer);
    });
  }

  function startSyncLoop() {
    let lastArchiveSync = 0;
    let syncUpRunning = false;
    setIntervalFn(() => {
      if (syncUpRunning) return;
      syncUpRunning = true;
      const now = Date.now();
      const includeArchives = !chromeProfileSnapshots.enabled() &&
        now - lastArchiveSync >= config.archiveSyncIntervalMs;
      const sync = Promise.all([
        piModelScope.persist(),
        workspaceSync.syncUp({includeArchives}),
      ]);
      sync
          .then(() => {
            if (includeArchives) lastArchiveSync = now;
          })
          .catch((error) => logger.error("sync up failed", error))
          .finally(() => {
            syncUpRunning = false;
          });
    }, config.syncIntervalMs);
  }

  return {shutdown, shutdownWithBudget, start};
}

module.exports = {createRunnerLifecycleCoordinator};
