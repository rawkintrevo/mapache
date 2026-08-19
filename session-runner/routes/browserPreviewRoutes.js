"use strict";

function registerBrowserRoutes({
  app,
  admin,
  browserVncWebSocketPath,
  chromeRuntime,
  config,
  activity,
  expressStatic,
  preview,
  requireBrowserAccess,
  requireBrowserOrRunnerAccess,
  renderTerminalPage,
}) {
  app.get("/", requireBrowserAccess, (req, res) => {
    res.type("html").send(renderTerminalPage({accessToken: req.mapacheAccessToken}));
  });

  app.get("/healthz", requireBrowserAccess, (req, res) => {
    res.json({
      ok: true,
      workspaceId: config.workspaceId,
      sessionId: config.sessionId,
      bucketName: config.bucketName,
      prefix: config.prefix,
    });
  });

  app.get("/capabilities", requireBrowserAccess, (req, res) => {
    res.json({
      ok: true,
      capabilities: config.runnerCapabilities,
      preview: preview.capabilityStatus(),
      browser: chromeRuntime.status(),
    });
  });

  app.get("/browser/status", requireBrowserAccess, (req, res) => {
    res.json({ok: true, browser: chromeRuntime.status()});
  });

  app.post("/browser/activity", requireBrowserOrRunnerAccess, async (req, res) => {
    const kind = String(req.body && req.body.kind || "browser").trim().slice(0, 32) || "browser";
    await activity.updateSessionActivity({
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      lastBrowserActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      lastBrowserActivityKind: kind,
    });
    res.json({ok: true, kind});
  });

  if (!config.chromeEnabled) return;

  app.get("/browser/", requireBrowserAccess, (req, res) => {
    const target = new URL(req.originalUrl || "/browser/", "http://localhost");
    target.pathname = "/browser/vnc.html";
    target.searchParams.set("autoconnect", "true");
    target.searchParams.set("resize", "remote");
    target.searchParams.set("path", browserVncWebSocketPath(req.mapacheAccessToken));
    res.redirect(`${target.pathname}?${target.searchParams.toString()}`);
  });
  app.use("/browser", requireBrowserAccess, expressStatic("/usr/share/novnc", {
    fallthrough: false,
  }));
}

function registerPreviewRoutes({app, browserQa, config, preview, requireBrowserAccess, storage, hasRunnerAccess}) {
  if (!config.previewEnabled) return;

  app.post(`${config.previewBasePath}/share`, async (req, res) => {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }

    try {
      res.json(await preview.shareStaticBuild(storage, req.body || {}));
    } catch (error) {
      console.error("preview share failed", error);
      res.status(error.status || 500).json({error: error.publicMessage || "preview_share_failed"});
    }
  });

  app.use(config.previewBasePath, requireBrowserAccess);

  app.get(`${config.previewBasePath}/status`, async (req, res) => {
    res.json(await preview.status());
  });

  app.get(`${config.previewBasePath}/qa/status`, async (req, res) => {
    const previewStatus = await preview.status();
    res.json({
      ok: true,
      qa: previewStatus.qa || browserQa.status(previewStatus),
    });
  });

  app.get(`${config.previewBasePath}/logs`, (req, res) => {
    res.json({ok: true, logs: preview.logs});
  });

  app.post(`${config.previewBasePath}/logs`, (req, res) => {
    const entry = preview.appendLog(req.body || {});
    res.json({ok: true, entry});
  });

  app.get(`${config.previewBasePath}/logs/stream`, (req, res) => {
    preview.streamLogs(req, res);
  });

  app.all(`${config.previewBasePath}/*`, async (req, res) => {
    await preview.serve(req, res);
  });

  app.get(config.previewBasePath, (req, res) => {
    res.redirect(`${config.previewBasePath}/`);
  });

  app.all(config.previewBasePath, async (req, res) => {
    await preview.serve(req, res);
  });
}

module.exports = {registerBrowserRoutes, registerPreviewRoutes};
