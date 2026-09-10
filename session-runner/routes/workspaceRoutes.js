"use strict";

function registerWorkspaceRoutes({
  app,
  hasRunnerAccess,
  shutdown,
  workspaceSync,
  executionAuthority,
  checkpoint,
  beforeMutation,
  afterMutation,
}) {
  app.get("/execution/status", (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    res.json({ok: true, execution: executionAuthority?.snapshot?.() || {enabled: false}});
  });

  app.get("/checkpoint/status", (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    res.json({ok: true, checkpoint: checkpoint?.status?.() || {enabled: false}});
  });

  app.post("/checkpoint", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    if (!checkpoint) return res.status(501).json({error: "checkpoint_unsupported"});
    try {
      res.json(await checkpoint.create({reason: req.body?.reason || "manual"}));
    } catch (error) {
      console.error("checkpoint failed", error);
      res.status(checkpointStatus(error)).json({error: error.code || "checkpoint_failed"});
    }
  });

  app.post("/checkpoint/verify", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    if (!checkpoint) return res.status(501).json({error: "checkpoint_unsupported"});
    try {
      res.json(await checkpoint.verifyRecovery());
    } catch (error) {
      console.error("checkpoint verification failed", error);
      res.status(checkpointStatus(error)).json({error: error.code || "checkpoint_verification_failed"});
    }
  });

  app.post("/checkpoint/restore", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    if (!checkpoint) return res.status(501).json({error: "checkpoint_unsupported"});
    try {
      res.json(await checkpoint.restore({destinationWorkspaceDir: req.body?.destinationWorkspaceDir}));
    } catch (error) {
      console.error("checkpoint restore failed", error);
      res.status(checkpointStatus(error)).json({error: error.code || "checkpoint_restore_failed"});
    }
  });

  app.post("/checkpoint/cleanup", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    if (!checkpoint) return res.status(501).json({error: "checkpoint_unsupported"});
    try {
      res.json(await checkpoint.cleanupOrphans({graceMs: req.body?.graceMs}));
    } catch (error) {
      console.error("checkpoint cleanup failed", error);
      res.status(checkpointStatus(error)).json({error: error.code || "checkpoint_cleanup_failed"});
    }
  });

  app.post("/workspace/sync-down", async (req, res) => {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }

    try {
      await beforeMutation?.("workspace_sync_down");
      await workspaceSync.syncDown();
      await afterMutation?.("workspace_sync_down");
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

function checkpointStatus(error) {
  if (["execution_authority_required", "execution_authority_lost", "checkpoint_authority_stale", "checkpoint_previous_pointer_conflict", "checkpoint_workspace_revision_conflict", "checkpoint_active_execution", "checkpoint_cleanup_in_progress"].includes(error?.code)) return 409;
  if (String(error?.code || "").includes("unsupported") || error?.code === "checkpoint_store_unavailable") return 503;
  return 500;
}

module.exports = {registerWorkspaceRoutes};
