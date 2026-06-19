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
      n64RomPath: config.runnerCapabilities.n64 ? config.previewN64RomPath : null,
    };
  }

  async function status() {
    const previewConfig = await readPreviewConfig();
    const staticRoot = previewConfig.staticRoot || config.previewStaticRoot;
    const indexPath = path.join(staticRoot, "index.html");
    const indexExists = await pathExists(indexPath);
    const rootExists = await pathExists(staticRoot);
    const upstreamReady = previewConfig.mode === "proxy" ? await previewUpstreamReady(previewConfig.upstream) : false;
    const romStat = previewConfig.mode === "n64" ? await statN64Rom(previewConfig.romPath) : null;
    return {
      ok: true,
      mode: previewConfig.mode,
      ready: previewConfig.mode === "proxy" ? upstreamReady : previewConfig.mode === "n64" ? Boolean(romStat) : indexExists,
      url: `${config.previewBasePath}/`,
      staticRoot,
      rootExists,
      indexExists,
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
  }

  async function shareStaticBuild(storage, body) {
    const previewConfig = await readPreviewConfig();
    if (previewConfig.mode !== "static") {
      throw publicError(400, "preview_share_requires_static_build");
    }
    const staticRoot = previewConfig.staticRoot || config.previewStaticRoot;
    const indexPath = path.join(staticRoot, "index.html");
    if (!await pathExists(indexPath)) {
      throw publicError(409, "preview_static_build_not_ready");
    }

    const bucketName = normalizeEnvString(body.bucketName);
    const storagePrefix = normalizeStoragePrefix(body.storagePrefix);
    if (!bucketName || !storagePrefix) {
      throw publicError(400, "preview_share_storage_not_configured");
    }

    const files = await listStaticFiles(staticRoot);
    const bucket = storage.bucket(bucketName);
    let sizeBytes = 0;
    for (const file of files) {
      sizeBytes += file.size;
      await bucket.upload(file.path, {
        destination: `${storagePrefix}/${file.relativePath}`,
        metadata: {
          cacheControl: "public, max-age=60",
          contentType: contentTypeForPreviewPath(file.path),
        },
      });
    }
    return {
      ok: true,
      fileCount: files.length,
      sizeBytes,
      storagePrefix,
    };
  }

  async function serve(req, res) {
    const previewConfig = await readPreviewConfig();
    if (previewConfig.mode === "proxy") {
      await proxyPreviewRequest(req, res, previewConfig);
      return;
    }
    if (previewConfig.mode === "n64") {
      await serveN64Preview(req, res, previewConfig);
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
      const mode = parsed.mode === "proxy" ? "proxy" : parsed.mode === "n64" ? "n64" : "static";
      const staticRoot = normalizePreviewStaticRoot(parsed.staticRoot) || config.previewStaticRoot;
      const upstream = normalizePreviewUpstream(parsed.upstream);
      const romPath = normalizeN64RomPath(parsed.rom || parsed.romPath) || config.previewN64RomPath;
      const emulatorCore = normalizeN64EmulatorCore(parsed.core || parsed.emulatorCore);
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

  function normalizeN64RomPath(value) {
    const clean = normalizeEnvString(value);
    if (!clean) return "";
    const resolved = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(config.workspaceDir, clean);
    if (!safePathInRoot(config.workspaceDir, resolved)) return "";
    if (![".n64", ".v64", ".z64"].includes(path.extname(resolved).toLowerCase())) return "";
    return resolved;
  }

  function normalizeN64EmulatorCore(value) {
    const clean = normalizeEnvString(value).toLowerCase();
    if (clean === "parallel_n64") return "parallel-n64";
    if (["mupen64plus_next", "parallel-n64", "n64"].includes(clean)) return clean;
    return "n64";
  }

  async function statN64Rom(romPath) {
    const normalized = normalizeN64RomPath(romPath);
    if (!normalized) return null;
    try {
      const stat = await fs.promises.stat(normalized);
      return stat.isFile() ? stat : null;
    } catch (error) {
      return null;
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
      res.send(injectPreviewLogger(html, req.mapacheAccessToken));
      return;
    }
    res.sendFile(filePath);
  }

  async function listStaticFiles(staticRoot) {
    const files = [];
    let sizeBytes = 0;
    const maxFiles = 1000;
    const maxBytes = 100 * 1024 * 1024;

    async function visit(dir) {
      const entries = await fs.promises.readdir(dir, {withFileTypes: true});
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (!safePathInRoot(staticRoot, fullPath)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await visit(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.promises.stat(fullPath);
        sizeBytes += stat.size;
        if (files.length >= maxFiles) throw publicError(413, "preview_static_build_too_many_files");
        if (sizeBytes > maxBytes) throw publicError(413, "preview_static_build_too_large");
        files.push({
          path: fullPath,
          relativePath: path.relative(staticRoot, fullPath).replace(/\\/g, "/"),
          size: stat.size,
        });
      }
    }

    await visit(staticRoot);
    return files;
  }

  function normalizeStoragePrefix(value) {
    return String(value || "")
        .replace(/\\/g, "/")
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean)
        .join("/");
  }

  async function serveN64Preview(req, res, previewConfig) {
    const requestedPath = safePreviewPath(req.params[0] || "index.html");
    if (!requestedPath) {
      res.status(400).send("invalid preview path");
      return;
    }

    if (requestedPath === "rom.z64") {
      const romPath = normalizeN64RomPath(previewConfig.romPath);
      if (!romPath || !await pathExists(romPath)) {
        res.status(404).send("n64 rom not found");
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${path.basename(romPath)}"`);
      res.sendFile(romPath);
      return;
    }

    if (requestedPath === "index.html" || requestedPath === "" || shouldServePreviewIndexFallback(req, requestedPath)) {
      const romStat = await statN64Rom(previewConfig.romPath);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(n64PreviewHtml({
        accessToken: req.mapacheAccessToken,
        emulatorCore: previewConfig.emulatorCore,
        ready: Boolean(romStat),
        romPath: previewConfig.romPath,
        romSize: romStat ? romStat.size : 0,
        romUrl: `${config.previewBasePath}/rom.z64`,
        statusUrl: `${config.previewBasePath}/status`,
      }));
      return;
    }

    res.status(404).send("preview file not found");
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
      ".n64": "application/octet-stream",
      ".v64": "application/octet-stream",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".z64": "application/octet-stream",
    };
    return types[extension] || "application/octet-stream";
  }

  function n64PreviewHtml({accessToken, emulatorCore, ready, romPath, romSize, romUrl, statusUrl}) {
    const title = ready ? "Mapache N64 Preview" : "Waiting for N64 ROM";
    const escapedRomPath = escapeHtml(romPath);
    const sizeText = ready ? `${Math.round(romSize / 1024)} KiB` : "not found";
    const core = normalizeN64EmulatorCore(emulatorCore);
    const signedRomUrl = appendAccessToken(romUrl, accessToken);
    const signedStatusUrl = appendAccessToken(statusUrl, accessToken);
    const loggerScript = previewLoggerScript(accessToken);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mapache N64 Preview</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body { margin: 0; background: #101114; color: #f4f4f5; overflow: hidden; }
    main { width: 100%; height: 100%; display: flex; flex-direction: column; }
    header { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 12px; background: #181a1f; border-bottom: 1px solid #2f3137; }
    h1 { margin: 0; font-size: 16px; }
    p { color: #c9cbd1; line-height: 1.55; }
    code { color: #f7d774; overflow-wrap: anywhere; }
    #game { flex: 1; min-height: 0; width: 100%; background: #050608; }
    .empty { width: min(720px, calc(100vw - 32px)); margin: auto; border: 1px solid #2f3137; border-radius: 8px; padding: 24px; background: #181a1f; }
    .meta { min-width: 0; }
    .meta p { margin: 2px 0 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    a { color: #101114; background: #f4f4f5; border-radius: 6px; padding: 8px 10px; text-decoration: none; font-size: 13px; font-weight: 700; }
    a.secondary { color: #f4f4f5; background: #2a2d34; }
    .status { display: inline-block; border-radius: 999px; padding: 4px 10px; background: ${ready ? "#244b35" : "#4b3d24"}; color: ${ready ? "#bdf4cd" : "#f4ddb0"}; }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="meta">
        <h1>${title} <span class="status">${ready ? "ready" : "waiting"}</span></h1>
        <p>ROM: <code>${escapedRomPath}</code> · ${escapeHtml(sizeText)} · core: <code>${escapeHtml(core)}</code></p>
      </div>
      <div class="actions">
        <a href="${escapeHtml(signedRomUrl)}">Download ROM</a>
        <a class="secondary" href="${escapeHtml(signedStatusUrl)}">Status</a>
      </div>
    </header>
    ${ready ? `<div id="game"></div>` : `<section class="empty">
      <h1>Waiting for N64 ROM</h1>
      <p>Build a homebrew ROM to <code>${escapedRomPath}</code>, then reload this preview.</p>
      <p>The emulator shell will load <code>${escapeHtml(romUrl)}</code> after the ROM exists.</p>
    </section>`}
  </main>
  ${loggerScript}
  ${ready ? `<script>
    window.EJS_player = "#game";
    window.EJS_core = ${JSON.stringify(core)};
    window.EJS_gameName = "Mapache N64 ROM";
    window.EJS_gameUrl = ${JSON.stringify(signedRomUrl)};
    window.EJS_pathtodata = "https://cdn.emulatorjs.org/stable/data/";
    window.EJS_startOnLoaded = true;
    window.EJS_volume = 0.35;
    window.EJS_threads = false;
    window.addEventListener("error", (event) => {
      console.error("N64 emulator shell error", event.message);
    });
  </script>
  <script src="https://cdn.emulatorjs.org/stable/data/loader.js" onerror="document.getElementById('game').innerHTML = '<section class=&quot;empty&quot;><h1>Emulator failed to load</h1><p>The ROM is available for download, but the EmulatorJS CDN could not be loaded from this browser session.</p></section>';"></script>` : ""}
</body>
</html>`;
  }

  function appendAccessToken(url, accessToken) {
    const token = normalizeEnvString(accessToken);
    if (!token) return url;
    const separator = String(url || "").includes("?") ? "&" : "?";
    return `${url}${separator}mapache_access=${encodeURIComponent(token)}`;
  }

  function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
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

module.exports = {
  createPreviewService,
};
