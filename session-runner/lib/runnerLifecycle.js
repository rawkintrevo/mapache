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
  setIntervalFn = setInterval,
  sshSession,
  workspace,
  workspaceSync,
}) {
  async function start() {
    await workspace.ensureWorkspace();
    logger.log(`workspace source mode: ${config.workspaceSourceMode}, sync policy mode: ${config.workspaceSyncPolicyMode}`);
    await workspace.prepareWorkspaceSource();
    await chromeProfile.restore();
    await chromeRuntime.start();
    await activeHarness.materializeConfig();
    await activeHarness.materializeAuth();
    await activeHarness.materializeMcp();
    await git.prepareGithubAutomationBranch();
    await activeHarness.materializeSkills();
    await activeHarness.materializeSubagents();
    chromeProfileSnapshots.start();
    startSyncLoop();
    listen(() => {
      logger.log(`session runner listening on ${config.port}`);
    });
  }

  async function shutdown() {
    sshSession.closeAll();
    await chromeRuntime.stop();
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
      const sync = workspaceSync.syncUp({includeArchives});
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
