"use strict";

function createRunnerLifecycleCoordinator({
  activity,
  activeHarness,
  admin,
  chromeProfile,
  chromeProfileSnapshots,
  chromeRuntime,
  config,
  executionAuthority,
  git,
  goalsPackage,
  listen,
  logger = console,
  piChat,
  resourceMetrics,
  piModelScope,
  setIntervalFn = setInterval,
  sshSession,
  workspace,
  workspaceSync,
  webFirst,
  checkpoint,
}) {
  async function start() {
    try {
      await workspace.ensureWorkspace();
      logger.log(`workspace source mode: ${config.workspaceSourceMode}, sync role: ${config.workspaceSyncRole}, sync policy mode: ${config.workspaceSyncPolicyMode}`);
      await workspace.prepareWorkspaceSource();
      const authority = await executionAuthority?.start?.();
      webFirst?.setExecutionEpoch?.(authority?.executionEpoch);
      if (config.webFirstEnabled && !executionAuthority?.canMutate?.()) {
        logger.warn("web-first runner is read-only until execution authority is acquired");
        await chromeRuntime.start();
        await webFirst?.initialize?.();
        listen(() => {
          logger.log(`session runner listening on ${config.port} (recovery required)`);
        });
        return;
      }
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
      if (config.webFirstEnabled && executionAuthority?.canMutate?.()) {
        await checkpoint?.ensureInitial?.().catch((error) => {
          logger.error("initial web-first checkpoint failed", error);
        });
      }
      await webFirst?.initialize?.();
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
    if (config.webFirstEnabled && executionAuthority?.canMutate?.()) {
      try {
        const current = await webFirst?.snapshot?.();
        if (!current?.control?.activeRun) await checkpoint?.create?.({reason: "shutdown"});
      } catch (error) {
        logger.error("final web-first checkpoint failed", error);
      }
    }
    piChat?.close?.();
    await webFirst?.close?.();
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
      await chromeProfileSnapshots.finalize();
    } else if (!config.webFirstEnabled) {
      await workspaceSync.syncUp({includeArchives: true});
    }
    await executionAuthority?.release?.("runner_shutdown");
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
      if (config.webFirstEnabled) {
        checkpoint?.create?.({reason: "periodic"})
            .catch((error) => logger.error("periodic checkpoint failed", error))
            .finally(() => { syncUpRunning = false; });
        return;
      }
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
