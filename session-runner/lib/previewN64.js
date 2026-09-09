"use strict";

const fs = require("fs");
const path = require("path");
const {normalizeEnvString, pathExists, safePathInRoot} = require("./utils");
const {
  appendAccessToken,
  escapeHtml,
  safePreviewPath,
  shouldServePreviewIndexFallback,
} = require("./previewHelpers");

function createN64PreviewService(config, deps = {}) {
  const previewLoggerScript = deps.previewLoggerScript || (() => "");

  async function serve(req, res, previewConfig) {
    const requestedPath = safePreviewPath(req.params[0] || "index.html");
    if (!requestedPath) {
      res.status(400).send("invalid preview path");
      return;
    }

    if (requestedPath === "rom.z64") {
      const romPath = normalizeRomPath(previewConfig.romPath);
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
      const romStat = await statRom(previewConfig.romPath);
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

  function normalizeRomPath(value) {
    const clean = normalizeEnvString(value);
    if (!clean) return "";
    const resolved = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(config.workspaceDir, clean);
    if (!safePathInRoot(config.workspaceDir, resolved)) return "";
    if (![".n64", ".v64", ".z64"].includes(path.extname(resolved).toLowerCase())) return "";
    return resolved;
  }

  function normalizeEmulatorCore(value) {
    const clean = normalizeEnvString(value).toLowerCase();
    if (clean === "parallel_n64") return "parallel-n64";
    if (["mupen64plus_next", "parallel-n64", "n64"].includes(clean)) return clean;
    return "n64";
  }

  async function statRom(romPath) {
    const normalized = normalizeRomPath(romPath);
    if (!normalized) return null;
    try {
      const stat = await fs.promises.stat(normalized);
      return stat.isFile() ? stat : null;
    } catch (error) {
      return null;
    }
  }

  function n64PreviewHtml({accessToken, emulatorCore, ready, romPath, romSize, romUrl, statusUrl}) {
    const title = ready ? "Mapache N64 Preview" : "Waiting for N64 ROM";
    const escapedRomPath = escapeHtml(romPath);
    const sizeText = ready ? `${Math.round(romSize / 1024)} KiB` : "not found";
    const core = normalizeEmulatorCore(emulatorCore);
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

  return {normalizeEmulatorCore, normalizeRomPath, serve, statRom};
}

module.exports = {createN64PreviewService};
