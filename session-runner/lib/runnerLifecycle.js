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
  listen,
  logger = console,
  piChat,
  resourceMetrics,
  piModelScope,
  setIntervalFn = setInterval,
  sshSession,
  workspace,
  workspaceSync,
}) {
  async function start() {
    try {
      await workspace.ensureWorkspace();
      logger.log(`workspace source mode: ${config.workspaceSourceMode}, sync role: ${config.workspaceSyncRole}, sync policy mode: ${config.workspaceSyncPolicyMode}`);
      await workspace.prepareWorkspaceSource();
      await piModelScope.restore();
      await chromeProfile.restore();
      await chromeRuntime.start();
      await activeHarness.materializeConfig();
      await activeHarness.materializeAuth();
      await git.prepareGithubAutomationBranch();
      await activeHarness.materializeMcp();
      await activeHarness.materializeSkills();
      await activeHarness.materializeSubagents();
      chromeProfileSnapshots.start();
      startSyncLoop();
      listen(() => {
        logger.log(`session runner listening on ${config.port}`);
      });
    } catch (error) {
      await activity.markRuntimeStartupFailure(error).catch((writeError) => {
        logger.error("session runtime failure write failed", writeError);
      });
      throw error;
    }
  }

  async function shutdown() {
    piChat?.close?.();
    resourceMetrics?.close?.();
    sshSession.closeAll();
    await chromeRuntime.stop();
    await piModelScope.persist().catch((error) => logger.error("Pi model scope sync failed during shutdown", error));
    if (chromeProfileSnapshots.enabled()) {
      await chromeProfileSnapshots.stop();
      await chromeProfileSnapshots.finalize();
    } else {
      await workspaceSync.syncUp({includeArchives: true});
    }
    await activity.updateSessionActivity({
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      shutdownRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
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

  return {shutdown, start};
}

module.exports = {createRunnerLifecycleCoordinator};
