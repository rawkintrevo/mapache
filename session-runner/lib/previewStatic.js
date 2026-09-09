"use strict";

const fs = require("fs");
const path = require("path");
const {normalizeEnvString, pathExists, safePathInRoot} = require("./utils");
const {
  contentTypeForPreviewPath,
  safePreviewPath,
  shouldServePreviewIndexFallback,
} = require("./previewHelpers");

function createStaticPreviewService(config, deps = {}) {
  const injectPreviewLogger = deps.injectPreviewLogger || ((html) => html);

  async function status(staticRoot) {
    const indexPath = path.join(staticRoot, "index.html");
    return {
      staticRoot,
      indexExists: await pathExists(indexPath),
      rootExists: await pathExists(staticRoot),
    };
  }

  async function serve(req, res, previewConfig) {
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
    if (!await pathExists(filePath) && shouldServePreviewIndexFallback(req, requestedPath)) {
      filePath = path.join(staticRoot, "index.html");
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

  function normalizeRoot(value) {
    const clean = normalizeEnvString(value);
    if (!clean) return "";
    const resolved = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(config.workspaceDir, clean);
    return safePathInRoot(config.workspaceDir, resolved) ? resolved : "";
  }

  async function isDirectory(filePath) {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isDirectory();
    } catch (error) {
      return false;
    }
  }

  return {normalizeRoot, serve, status};
}

module.exports = {createStaticPreviewService};
