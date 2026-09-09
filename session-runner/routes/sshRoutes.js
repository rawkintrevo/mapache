"use strict";

function registerSshRoutes({app, hasRunnerAccess, requireBrowserAccess, sshSession}) {
  app.get("/ssh/files", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
    try {
      res.json(await sshSession.listFiles(req.query.path || ""));
    } catch (error) {
      console.error("ssh file list failed", error);
      res.status(error.status || 502).json({error: error.publicMessage || error.message || "ssh_file_list_failed"});
    }
  });

  app.get("/ssh/file", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
    try {
      res.json(await sshSession.readFile(req.query.path || ""));
    } catch (error) {
      console.error("ssh file read failed", error);
      res.status(error.status || 502).json({error: error.publicMessage || error.message || "ssh_file_read_failed"});
    }
  });

  app.put("/ssh/file", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
    try {
      res.json(await sshSession.saveFile(req.query.path || "", String((req.body || {}).content || "")));
    } catch (error) {
      console.error("ssh file save failed", error);
      res.status(error.status || 502).json({error: error.publicMessage || error.message || "ssh_file_save_failed"});
    }
  });

  app.get("/ssh/ports", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
    res.json({ok: true, forwards: sshSession.listForwards()});
  });

  app.post("/ssh/ports", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
    try {
      res.status(201).json(await sshSession.createForward((req.body || {}).port));
    } catch (error) {
      console.error("ssh forward create failed", error);
      res.status(error.status || 502).json({error: error.publicMessage || error.message || "ssh_forward_create_failed"});
    }
  });

  app.delete("/ssh/ports/:port", async (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
    try {
      res.json(sshSession.closeForward(req.params.port));
    } catch (error) {
      res.status(error.status || 400).json({error: error.message || "ssh_forward_close_failed"});
    }
  });

  app.use("/ssh/forward/:port", requireBrowserAccess);
  app.all("/ssh/forward/:port/*", (req, res) => sshSession.proxyForward(req, res, req.params.port));
  app.all("/ssh/forward/:port", (req, res) => sshSession.proxyForward(req, res, req.params.port));
}

module.exports = {registerSshRoutes};
