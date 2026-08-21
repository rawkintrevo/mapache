"use strict";

function registerAgentRoutes({app, hasRunnerAccess, pi, piModelScope, sendPiPackageError, sendPiSkillError, workspace}) {
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

  app.get("/models", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await piModelScope.listModels());
    } catch (error) {
      console.error("pi model list failed", error);
      res.status(500).json({error: "pi_model_list_failed"});
    }
  });

  app.put("/models", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await piModelScope.save(req.body && req.body.scopedModels));
    } catch (error) {
      console.error("pi model scope save failed", error);
      res.status(500).json({error: "pi_model_scope_save_failed"});
    }
  });

  app.get("/pi/packages", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withPackageOperationLock({read: true}, pi.listWorkspacePiPackages));
    } catch (error) {
      sendPiPackageError(res, error, "pi_package_list_failed");
    }
  });

  app.post("/pi/packages/install", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withPackageOperationLock({read: false}, () => pi.installWorkspacePiPackage(req.body || {})));
    } catch (error) {
      sendPiPackageError(res, error, "pi_package_install_failed");
    }
  });

  app.post("/pi/packages/remove", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withPackageOperationLock({read: false}, () => pi.removeWorkspacePiPackage(req.body || {})));
    } catch (error) {
      sendPiPackageError(res, error, "pi_package_remove_failed");
    }
  });

  app.post("/pi/packages/update", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withPackageOperationLock({read: false}, () => pi.updateWorkspacePiPackages(req.body || {})));
    } catch (error) {
      sendPiPackageError(res, error, "pi_package_update_failed");
    }
  });

  async function handleWorkspaceSkillList(req, res) {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withSkillOperationLock({read: true}, pi.listWorkspaceSkills));
    } catch (error) {
      sendPiSkillError(res, error, "pi_skill_list_failed");
    }
  }

  async function handleWorkspaceSkillSave(req, res) {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withSkillOperationLock({read: false}, () => pi.saveWorkspaceSkill(req.body || {})));
    } catch (error) {
      sendPiSkillError(res, error, "pi_skill_save_failed");
    }
  }

  async function handleWorkspaceSkillDelete(req, res) {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withSkillOperationLock({read: false}, () => pi.deleteWorkspaceSkill(req.body || {})));
    } catch (error) {
      sendPiSkillError(res, error, "pi_skill_delete_failed");
    }
  }

  app.get("/skills", handleWorkspaceSkillList);
  app.post("/skills", handleWorkspaceSkillSave);
  app.post("/skills/delete", handleWorkspaceSkillDelete);
  app.get("/pi/skills", handleWorkspaceSkillList);
  app.post("/pi/skills", handleWorkspaceSkillSave);
  app.post("/pi/skills/delete", handleWorkspaceSkillDelete);

  async function handleWorkspaceSubagentList(req, res) {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withSubagentOperationLock({read: true}, pi.listWorkspaceSubagents));
    } catch (error) {
      sendPiSkillError(res, error, "subagent_list_failed");
    }
  }

  async function handleWorkspaceSubagentSave(req, res) {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withSubagentOperationLock({read: false}, () => pi.saveWorkspaceSubagent(req.body || {})));
    } catch (error) {
      sendPiSkillError(res, error, "subagent_save_failed");
    }
  }

  async function handleWorkspaceSubagentDelete(req, res) {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withSubagentOperationLock({read: false}, () => pi.deleteWorkspaceSubagent(req.body || {})));
    } catch (error) {
      sendPiSkillError(res, error, "subagent_delete_failed");
    }
  }

  async function handleWorkspaceSubagentChains(req, res) {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withSubagentOperationLock({read: true}, pi.listWorkspaceSubagentChains));
    } catch (error) {
      sendPiSkillError(res, error, "subagent_chains_list_failed");
    }
  }

  app.get("/subagents", handleWorkspaceSubagentList);
  app.post("/subagents", handleWorkspaceSubagentSave);
  app.post("/subagents/delete", handleWorkspaceSubagentDelete);
  app.get("/subagent-chains", handleWorkspaceSubagentChains);
  app.post("/subagent-chains", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withSubagentOperationLock({read: false}, () => pi.saveWorkspaceSubagentChain(req.body || {})));
    } catch (error) {
      sendPiSkillError(res, error, "subagent_chains_save_failed");
    }
  });
  app.post("/subagent-chains/delete", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(await pi.withSubagentOperationLock({read: false}, () => pi.deleteWorkspaceSubagentChain(req.body || {})));
    } catch (error) {
      sendPiSkillError(res, error, "subagent_chains_delete_failed");
    }
  });
}

module.exports = {registerAgentRoutes};
