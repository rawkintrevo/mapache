"use strict";

function createRunnerLifecycleCoordinator({
  activity,
  activeHarness,
  admin,
  chromeProfile,
  chromeProfileSnapshots,
  chromeRuntime,
  config,
  git,
  goalsPackage,
  listen,
  logger = console,
  piChat,
  piWebUi,
  resourceMetrics,
  piModelScope,
  setIntervalFn = setInterval,
  sshSession,
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

  async function start() {
    try {
      await workspace.ensureWorkspace();
      logger.log(`workspace source mode: ${config.workspaceSourceMode}, sync role: ${config.workspaceSyncRole}, sync policy mode: ${config.workspaceSyncPolicyMode}`);
      await workspace.prepareWorkspaceSource();
      await authority.acquire();
      const goalsPackageResult = await goalsPackage?.ensureInstalledDeclaration?.();
      goalsPackage?.setBridgeAvailability?.(goalsPackageResult?.enabled !== false);
      if (goalsPackageResult?.reason === "managed_package_missing") {
        (logger.warn || logger.log || console.warn)("managed pi-goal-x package is missing from the image; goal controls remain disabled");
      }
      await piModelScope.restore();
      await chromeProfile.restore();
      await chromeRuntime.start();
      await activeHarness.materializeConfig();
      await activeHarness.materializeAuth();
      await git.prepareGithubAutomationBranch();
      await activeHarness.materializeMcp();
      await activeHarness.materializeSkills();
      await activeHarness.materializeSubagents();
      if (config.agentRuntimeEnabled) await piWebUi.start();
      chromeProfileSnapshots.start();
      startSyncLoop();
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
    try {
      if (config.agentRuntimeEnabled) await piWebUi?.stop?.();
      piChat?.close?.();
      try {
        await goalsPackage?.stop?.();
      } catch (error) {
        logger.error("goal RPC shutdown failed", error);
      }
      resourceMetrics?.close?.();
      sshSession.closeAll();
      await chromeRuntime.stop();
      await piModelScope.persist().catch((error) => logger.error("Pi model scope sync failed during shutdown", error));
      if (chromeProfileSnapshots.enabled()) {
        await chromeProfileSnapshots.stop();
        if (authority.isCurrentWriter()) {
          await chromeProfileSnapshots.finalize();
        } else {
          logger.warn?.("final Chrome profile snapshot skipped after writer authority loss");
        }
      } else if (authority.isCurrentWriter()) {
        await workspaceSync.syncUp({includeArchives: true});
      } else {
        logger.warn?.("final workspace sync skipped after writer authority loss");
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

  return {shutdown, start};
}

module.exports = {createRunnerLifecycleCoordinator};
