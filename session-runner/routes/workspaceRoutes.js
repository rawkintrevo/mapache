"use strict";

function registerWorkspaceRoutes({
  app,
  hasRunnerAccess,
  shutdown,
  snapshotChromeProfile,
  workspaceSync,
}) {
  app.post("/workspace/chrome-profile/snapshot", async (req, res) => {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }

    try {
      const result = await snapshotChromeProfile?.({requested: true, reason: req.body?.reason || "requested"});
      const seed = result?.result?.descriptor || null;
      if (!seed) {
        res.status(409).json({error: "chrome_profile_capture_unavailable"});
        return;
      }
      res.json({ok: true, seed});
    } catch (error) {
      console.error("Chrome profile seed capture failed", error);
      res.status(503).json({error: error.code || "chrome_profile_capture_failed"});
    }
  });

  app.post("/workspace/sync-down", async (req, res) => {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }

    try {
      await workspaceSync.syncDown();
      res.json({ok: true});
    } catch (error) {
      console.error("workspace sync down failed", error);
      res.status(500).json({error: "workspace_sync_down_failed"});
    }
  });

  app.post("/shutdown", async (req, res) => {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }

    try {
      await shutdown();
      res.json({ok: true});
    } catch (error) {
      console.error("shutdown sync failed", error);
      res.status(500).json({error: "shutdown_sync_failed"});
    }
  });
}

module.exports = {registerWorkspaceRoutes};
