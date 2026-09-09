"use strict";

const fs = require("fs");
const {createN64PreviewService} = require("./previewN64");
const {createProxyPreviewService} = require("./previewProxy");
const {createPreviewLogService} = require("./previewLog.service");
const {createPreviewShareService} = require("./previewShare.service");
const {createStaticPreviewService} = require("./previewStatic");

function createPreviewService(config, deps = {}) {
  const browserQa = deps.browserQa || null;
  const previewLog = createPreviewLogService(config);
  const staticPreview = createStaticPreviewService(config, {
    injectPreviewLogger: previewLog.injectHtmlLogger,
  });
  const previewProxy = createProxyPreviewService(config, {appendLog: previewLog.appendLog});
  const previewShare = createPreviewShareService();
  const n64Preview = createN64PreviewService(config, {previewLoggerScript: previewLog.loggerScript});

  function capabilityStatus() {
    const status = {
      enabled: config.previewEnabled,
      basePath: config.previewBasePath,
      staticRoot: config.previewStaticRoot,
      injectLogger: config.previewInjectLogger,
      n64RomPath: config.runnerCapabilities.n64 ? config.previewN64RomPath : null,
    };
    if (browserQa) {
      status.qa = browserQa.capabilityStatus();
    }
    return status;
  }

  async function status() {
    const previewConfig = await readPreviewConfig();
    const staticStatus = await staticPreview.status(previewConfig.staticRoot || config.previewStaticRoot);
    const upstreamReady = previewConfig.mode === "proxy" ? await previewProxy.isReady(previewConfig.upstream) : false;
    const romStat = previewConfig.mode === "n64" ? await n64Preview.statRom(previewConfig.romPath) : null;
    const response = {
      ok: true,
      mode: previewConfig.mode,
      ready: previewConfig.mode === "proxy" ? upstreamReady : previewConfig.mode === "n64" ? Boolean(romStat) : staticStatus.indexExists,
      url: `${config.previewBasePath}/`,
      staticRoot: staticStatus.staticRoot,
      rootExists: staticStatus.rootExists,
      indexExists: staticStatus.indexExists,
      upstream: previewConfig.mode === "proxy" ? previewConfig.upstream : null,
      upstreamReady,
      n64: previewConfig.mode === "n64" ? {
        emulatorCore: previewConfig.emulatorCore,
        romPath: previewConfig.romPath,
        romExists: Boolean(romStat),
        romSize: romStat ? romStat.size : 0,
        romUrl: `${config.previewBasePath}/rom.z64`,
      } : null,
      configPath: config.previewConfigPath,
      logs: {
        count: previewLog.logs.length,
        limit: config.previewLogLimit,
      },
    };
    if (browserQa) {
      response.qa = browserQa.status(response);
    }
    return response;
  }

  async function shareStaticBuild(storage, body) {
    const previewConfig = await readPreviewConfig();
    if (previewConfig.mode !== "static") {
      throw publicError(400, "preview_share_requires_static_build");
    }
    return previewShare.shareStaticBuild(
        storage,
        body,
        previewConfig.staticRoot || config.previewStaticRoot,
    );
  }

  async function serve(req, res) {
    const previewConfig = await readPreviewConfig();
    if (previewConfig.mode === "proxy") {
      await previewProxy.serve(req, res, previewConfig);
      return;
    }
    if (previewConfig.mode === "n64") {
      await n64Preview.serve(req, res, previewConfig);
      return;
    }
    await staticPreview.serve(req, res, previewConfig);
  }

  async function readPreviewConfig() {
    const fallback = {
      mode: "static",
      staticRoot: config.previewStaticRoot,
      upstream: "",
    };
    try {
      const raw = await fs.promises.readFile(config.previewConfigPath, "utf8");
      const parsed = JSON.parse(raw);
      const mode = parsed.mode === "proxy" ? "proxy" : parsed.mode === "n64" ? "n64" : "static";
      const staticRoot = staticPreview.normalizeRoot(parsed.staticRoot) || config.previewStaticRoot;
      const upstream = previewProxy.normalizeUpstream(parsed.upstream);
      const romPath = n64Preview.normalizeRomPath(parsed.rom || parsed.romPath) || config.previewN64RomPath;
      const emulatorCore = n64Preview.normalizeEmulatorCore(parsed.core || parsed.emulatorCore);
      return {
        mode: mode === "proxy" && upstream ? "proxy" : mode === "n64" && config.runnerCapabilities.n64 ? "n64" : "static",
        emulatorCore,
        romPath,
        staticRoot,
        upstream,
      };
    } catch (error) {
      if (config.runnerCapabilities.n64) {
        return {...fallback, emulatorCore: "n64", mode: "n64", romPath: config.previewN64RomPath};
      }
      return fallback;
    }
  }

  return {
    appendLog: previewLog.appendLog,
    capabilityStatus,
    logs: previewLog.logs,
    serve,
    shareStaticBuild,
    status,
    streamLogs: previewLog.streamLogs,
  };
}

function publicError(status, publicMessage) {
  const error = new Error(publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  return error;
}

module.exports = {createPreviewService};
