"use strict";

const fs = require("fs");
const {createN64PreviewService} = require("./previewN64");
const {createProxyPreviewService} = require("./previewProxy");
const {createStaticPreviewService} = require("./previewStatic");
const {appendAccessToken} = require("./previewHelpers");

function createPreviewService(config, deps = {}) {
  const browserQa = deps.browserQa || null;
  const previewLogs = [];
  const previewLogStreams = new Set();
  const staticPreview = createStaticPreviewService(config, {injectPreviewLogger});
  const proxyPreview = createProxyPreviewService(config, {appendLog});
  const n64Preview = createN64PreviewService(config, {previewLoggerScript});

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
    const upstreamReady = previewConfig.mode === "proxy" ? await proxyPreview.isReady(previewConfig.upstream) : false;
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
        count: previewLogs.length,
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
    return staticPreview.shareStaticBuild(
        storage,
        body,
        previewConfig.staticRoot || config.previewStaticRoot,
    );
  }

  async function serve(req, res) {
    const previewConfig = await readPreviewConfig();
    if (previewConfig.mode === "proxy") {
      await proxyPreview.serve(req, res, previewConfig);
      return;
    }
    if (previewConfig.mode === "n64") {
      await n64Preview.serve(req, res, previewConfig);
      return;
    }
    await staticPreview.serve(req, res, previewConfig);
  }

  function streamLogs(req, res) {
    res.writeHead(200, {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream",
    });
    for (const entry of previewLogs) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    previewLogStreams.add(res);
    req.on("close", () => {
      previewLogStreams.delete(res);
    });
  }

  function appendLog(body) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      level: normalizePreviewLogLevel(body.level),
      args: Array.isArray(body.args) ? body.args.map((item) => String(item).slice(0, 2000)) : [],
      href: String(body.href || "").slice(0, 2000),
      at: body.at || new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    };
    previewLogs.push(entry);
    if (previewLogs.length > config.previewLogLimit) {
      previewLogs.splice(0, previewLogs.length - config.previewLogLimit);
    }
    for (const stream of previewLogStreams) {
      stream.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    return entry;
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
      const upstream = proxyPreview.normalizeUpstream(parsed.upstream);
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

  function injectPreviewLogger(html, accessToken) {
    const script = previewLoggerScript(accessToken);
    if (html.includes("</head>")) return html.replace("</head>", `${script}</head>`);
    if (html.includes("</body>")) return html.replace("</body>", `${script}</body>`);
    return `${script}${html}`;
  }

  function previewLoggerScript(accessToken) {
    const endpoint = appendAccessToken(`${config.previewBasePath}/logs`, accessToken);
    return `<script>
(() => {
  if (window.__mapachePreviewLoggerInstalled) return;
  window.__mapachePreviewLoggerInstalled = true;
  const endpoint = ${JSON.stringify(endpoint)};
  const serialize = (item) => {
    if (typeof item === "string") return item;
    if (item instanceof Error) return item.stack || item.message || String(item);
    try {
      const json = JSON.stringify(item);
      return typeof json === "string" ? json : String(item);
    } catch (error) {
      return String(item);
    }
  };
  const send = (level, args) => {
    const payload = {
      level,
      args: Array.from(args || []).map(serialize),
      href: location.href,
      at: new Date().toISOString()
    };
    fetch(endpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      send(level, args);
      original.apply(console, args);
    };
  }
  window.addEventListener("error", (event) => {
    send("error", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    send("error", ["Unhandled rejection", event.reason]);
  });
})();
</script>`;
  }

  return {
    appendLog,
    capabilityStatus,
    logs: previewLogs,
    serve,
    shareStaticBuild,
    status,
    streamLogs,
  };
}

function normalizePreviewLogLevel(level) {
  const value = String(level || "log").toLowerCase();
  return ["log", "info", "warn", "error"].includes(value) ? value : "log";
}

function publicError(status, publicMessage) {
  const error = new Error(publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  return error;
}

module.exports = {createPreviewService};
