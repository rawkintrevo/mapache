"use strict";

function registerGoalsRoutes({app, goalsBridge, hasRunnerAccess}) {
  app.get("/goals/capabilities", (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    res.json(goalsBridge.capabilities());
  });

  app.get("/goals/snapshot", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await goalsBridge.snapshot());
    } catch (error) {
      console.error("goal snapshot failed", error);
      res.status(500).json({error: "goal_snapshot_failed"});
    }
  });

  app.get("/goals/operations/:operationId", (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    const operation = typeof goalsBridge.operation === "function" ? goalsBridge.operation(req.params.operationId) : null;
    if (!operation) return res.status(404).json({error: "goal_operation_not_found"});
    res.json(operation);
  });

  app.post("/goals/commands", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await goalsBridge.command(req.body || {}));
    } catch (error) {
      const code = error && error.code || "goal_command_failed";
      const status = ["goal_protocol_unsupported", "goal_bridge_unavailable", "goal_structured_dialogs_unavailable"].includes(code) ? 503 : 400;
      res.status(status).json({error: code});
    }
  });
}

module.exports = {registerGoalsRoutes};
