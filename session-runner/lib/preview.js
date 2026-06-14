"use strict";

const fs = require("fs");
const path = require("path");
const {normalizeEnvString, pathExists, safePathInRoot} = require("./utils");

function createPreviewService(config) {
  const previewLogs = [];
  const previewLogStreams = new Set();

  function capabilityStatus() {
    return {
      enabled: config.previewEnabled,
      basePath: config.previewBasePath,
      staticRoot: config.previewStaticRoot,
      injectLogger: config.previewInjectLogger,
    };
  }

  async function status() {
    const previewConfig = await readPreviewConfig();
    const staticRoot = previewConfig.staticRoot || config.previewStaticRoot;
    const indexPath = path.join(staticRoot, "index.html");
    const indexExists = await pathExists(indexPath);
    const rootExists = await pathExists(staticRoot);
    const upstreamReady = previewConfig.mode === "proxy" ? await previewUpstreamReady(previewConfig.upstream) : false;
    return {
      ok: true,
      mode: previewConfig.mode,
      ready: previewConfig.mode === "proxy" ? upstreamReady : indexExists,
      url: `${config.previewBasePath}/`,
      staticRoot,
      rootExists,
      indexExists,
      upstream: previewConfig.mode === "proxy" ? previewConfig.upstream : null,
      upstreamReady,
      configPath: config.previewConfigPath,
      logs: {
        count: previewLogs.length,
        limit: config.previewLogLimit,
      },
    };
  }

  async function serve(req, res) {
    const previewConfig = await readPreviewConfig();
    if (previewConfig.mode === "proxy") {
      await proxyPreviewRequest(req, res, previewConfig);
      return;
    }
    await servePreviewStatic(req, res, previewConfig);
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
      const mode = parsed.mode === "proxy" ? "proxy" : "static";
      const staticRoot = normalizePreviewStaticRoot(parsed.staticRoot) || config.previewStaticRoot;
      const upstream = normalizePreviewUpstream(parsed.upstream);
      return {
        mode: mode === "proxy" && upstream ? "proxy" : "static",
        staticRoot,
        upstream,
      };
    } catch (error) {
      return fallback;
    }
  }

  function normalizePreviewStaticRoot(value) {
    const clean = normalizeEnvString(value);
    if (!clean) return "";
    const resolved = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(config.workspaceDir, clean);
    return safePathInRoot(config.workspaceDir, resolved) ? resolved : "";
  }

  function normalizePreviewUpstream(value) {
    const clean = normalizeEnvString(value);
    if (!clean) return "";
    try {
      const parsed = new URL(clean);
      if (!["http:", "https:"].includes(parsed.protocol)) return "";
      if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return "";
      parsed.hash = "";
      return parsed.toString().replace(/\/+$/, "");
    } catch (error) {
      return "";
    }
  }

  async function previewUpstreamReady(upstream) {
    if (!upstream) return false;
    return new Promise((resolve) => {
      const url = new URL(upstream);
      const request = (url.protocol === "https:" ? require("https") : require("http")).request({
        hostname: url.hostname,
        method: "GET",
        path: `${url.pathname || "/"}${url.search || ""}`,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        protocol: url.protocol,
        timeout: 1500,
      }, (response) => {
        response.resume();
        resolve(true);
      });
      request.on("error", () => resolve(false));
      request.on("timeout", () => {
        request.destroy();
        resolve(false);
      });
      request.end();
    });
  }

  async function proxyPreviewRequest(req, res, previewConfig) {
    const upstream = normalizePreviewUpstream(previewConfig.upstream);
    if (!upstream) {
      res.status(502).send("preview upstream is not configured");
      return;
    }

    const upstreamUrl = new URL(upstream);
    const relativePath = req.params[0] || "";
    const requestPath = joinProxyPath(upstreamUrl.pathname, relativePath, req.url);
    const client = upstreamUrl.protocol === "https:" ? require("https") : require("http");
    const headers = {...req.headers, host: upstreamUrl.host};
    if (req.body && Object.keys(req.body).length) {
      delete headers["content-length"];
    }
    const proxyReq = client.request({
      headers,
      hostname: upstreamUrl.hostname,
      method: req.method,
      path: requestPath,
      port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
      protocol: upstreamUrl.protocol,
    }, (proxyRes) => {
      const responseHeaders = {...proxyRes.headers, "cache-control": "no-store"};
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (error) => {
      appendLog({
        level: "error",
        args: [`Preview upstream request failed: ${error.message}`],
        href: `${config.previewBasePath}/${relativePath}`,
      });
      if (!res.headersSent) res.status(502).send("preview upstream unavailable");
    });

    if (req.body && Object.keys(req.body).length) {
      proxyReq.end(JSON.stringify(req.body));
      return;
    }
    req.pipe(proxyReq);
  }

  function joinProxyPath(upstreamBasePath, relativePath, originalUrl) {
    const queryIndex = originalUrl.indexOf("?");
    const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : "";
    const base = upstreamBasePath && upstreamBasePath !== "/" ? upstreamBasePath.replace(/\/+$/, "") : "";
    const cleanRelative = `/${String(relativePath || "").replace(/^\/+/, "")}`;
    return `${base}${cleanRelative}${query}`;
  }

  async function servePreviewStatic(req, res, previewConfig) {
    const staticRoot = previewConfig.staticRoot || config.previewStaticRoot;
    const requestedPath = safePreviewPath(req.params[0] || "index.html");
    if (!requestedPath) {
      res.status(400).send("invalid preview path");
      return;
    }

    let filePath = path.join(staticRoot, requestedPath);
    if (await isDirectory(filePath)) {
      filePath = path.join(filePath, "index.html");
    }
    if (!await pathExists(filePath)) {
      if (shouldServePreviewIndexFallback(req, requestedPath)) {
        filePath = path.join(staticRoot, "index.html");
      }
    }
    if (!safePathInRoot(staticRoot, filePath) || !await pathExists(filePath)) {
      res.status(404).send("preview file not found");
      return;
    }

    const contentType = contentTypeForPreviewPath(filePath);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", contentType);
    if (config.previewInjectLogger && contentType.startsWith("text/html")) {
      const html = await fs.promises.readFile(filePath, "utf8");
      res.send(injectPreviewLogger(html));
      return;
    }
    res.sendFile(filePath);
  }

  function safePreviewPath(value) {
    const clean = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const normalized = path.posix.normalize(clean);
    if (!normalized || normalized === ".") return "index.html";
    if (normalized === ".." || normalized.startsWith("../")) return "";
    return normalized;
  }

  function shouldServePreviewIndexFallback(req, requestedPath) {
    if (!path.extname(requestedPath)) return true;
    return String(req.get("accept") || "").includes("text/html");
  }

  async function isDirectory(filePath) {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isDirectory();
    } catch (error) {
      return false;
    }
  }

  function contentTypeForPreviewPath(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    const types = {
      ".css": "text/css; charset=utf-8",
      ".gif": "image/gif",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".map": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".txt": "text/plain; charset=utf-8",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };
    return types[extension] || "application/octet-stream";
  }

  function injectPreviewLogger(html) {
    const script = `<script>
(() => {
  if (window.__mapachePreviewLoggerInstalled) return;
  window.__mapachePreviewLoggerInstalled = true;
  const endpoint = ${JSON.stringify(`${config.previewBasePath}/logs`)};
  const send = (level, args) => {
    const payload = {
      level,
      args: Array.from(args || []).map((item) => {
        try {
          return typeof item === "string" ? item : JSON.stringify(item);
        } catch (error) {
          return String(item);
        }
      }),
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
    if (html.includes("</head>")) return html.replace("</head>", `${script}</head>`);
    if (html.includes("</body>")) return html.replace("</body>", `${script}</body>`);
    return `${script}${html}`;
  }

  return {
    appendLog,
    capabilityStatus,
    logs: previewLogs,
    serve,
    status,
    streamLogs,
  };
}

function normalizePreviewLogLevel(level) {
  const value = String(level || "log").toLowerCase();
  return ["log", "info", "warn", "error"].includes(value) ? value : "log";
}

module.exports = {
  createPreviewService,
};
