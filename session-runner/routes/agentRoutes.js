"use strict";

function registerAgentRoutes({app, hasRunnerAccess, workspace}) {
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
}

module.exports = {registerAgentRoutes};
