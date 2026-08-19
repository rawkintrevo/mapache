"use strict";

function registerWorkspaceRoutes({
  app,
  hasRunnerAccess,
  shutdown,
  workspaceSync,
}) {
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
