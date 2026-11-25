"use strict";

function registerAgentRoutes({app, automationExecution, hasRunnerAccess, piWebUi, workspace}) {
  async function handleAuthMaterialize(req, res) {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }

    try {
      res.json(await workspace.materializeAuthNow(req.body && req.body.selection));
    } catch (error) {
      console.error("auth materialize failed", error);
      res.status(500).json({error: "auth_materialize_failed"});
    }
  }

  app.post("/auth/materialize", handleAuthMaterialize);
  app.post("/pi/auth/materialize", handleAuthMaterialize);

  async function handleWorkspaceRequest(req, res) {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }
    try {
      const result = await piWebUi.startWorkspaceRequest(req.body || {});
      res.json(result);
    } catch (error) {
      console.error("workspace request start failed", error);
      res.status(500).json({error: error.publicMessage || "workspace_request_start_failed"});
    }
  }

  async function handleWorkspaceRequestStatus(req, res) {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }
    try {
      const result = await piWebUi.workspaceRequestStatus(req.params.runId);
      if (result?.error === "workspace_request_not_found") {
        res.status(404).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      console.error("workspace request status failed", error);
      res.status(500).json({error: error.publicMessage || "workspace_request_status_failed"});
    }
  }

  async function handleWorkspaceRequestModels(req, res) {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }
    try {
      const result = await piWebUi.workspaceRequestModels();
      if (result?.error === "pi_web_ui_not_ready") {
        res.status(503).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      console.error("workspace request model discovery failed", error);
      res.status(500).json({error: error.publicMessage || "workspace_request_model_discovery_failed"});
    }
  }

  async function handleWorkspaceRequestCancel(req, res) {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }
    try {
      res.json(await piWebUi.cancelWorkspaceRequest(req.params.runId));
    } catch (error) {
      console.error("workspace request cancel failed", error);
      res.status(500).json({error: error.publicMessage || "workspace_request_cancel_failed"});
    }
  }

  app.post("/workspace/requests", handleWorkspaceRequest);
  app.get("/workspace/models", handleWorkspaceRequestModels);
  app.get("/workspace/requests/:runId", handleWorkspaceRequestStatus);
  app.post("/workspace/requests/:runId/cancel", handleWorkspaceRequestCancel);

  async function handleAutomationStart(req, res) {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }
    try {
      const result = await automationExecution?.startRun?.(req.body?.runId);
      if (result?.error === "automation_run_busy") {
        res.status(409).json(result);
        return;
      }
      res.json(result || {ok: false, error: "automation_execution_unavailable"});
    } catch (error) {
      console.error("VM automation start failed", error);
      res.status(500).json({error: error.publicMessage || "automation_start_failed"});
    }
  }

  async function handleAutomationStatus(req, res) {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }
    try {
      const result = await automationExecution?.statusFor?.(req.params.runId);
      if (result?.error === "automation_run_not_found") {
        res.status(404).json(result);
        return;
      }
      res.json(result || {ok: false, error: "automation_execution_unavailable"});
    } catch (error) {
      console.error("VM automation status failed", error);
      res.status(500).json({error: error.publicMessage || "automation_status_failed"});
    }
  }

  async function handleAutomationCancel(req, res) {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }
    try {
      const result = await automationExecution?.cancelRun?.(req.params.runId);
      if (result?.error === "automation_run_busy") {
        res.status(409).json(result);
        return;
      }
      if (result?.error === "automation_run_not_found") {
        res.status(404).json(result);
        return;
      }
      res.json(result || {ok: false, error: "automation_execution_unavailable"});
    } catch (error) {
      console.error("VM automation cancellation failed", error);
      res.status(500).json({error: error.publicMessage || "automation_cancel_failed"});
    }
  }

  app.post("/automation/runs", handleAutomationStart);
  app.get("/automation/runs/:runId", handleAutomationStatus);
  app.post("/automation/runs/:runId/cancel", handleAutomationCancel);
}

module.exports = {registerAgentRoutes};
