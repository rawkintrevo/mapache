"use strict";

const fs = require("fs");
const path = require("path");
const {normalizeEnvString, pathExists, safePathInRoot} = require("./utils");
const {
  contentTypeForPreviewPath,
  normalizeStoragePrefix,
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

  async function shareStaticBuild(storage, body, staticRoot) {
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

  async function isDirectory(filePath) {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isDirectory();
    } catch (error) {
      return false;
    }
  }

  return {normalizeRoot, serve, shareStaticBuild, status};
}

function publicError(status, publicMessage) {
  const error = new Error(publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  return error;
}

module.exports = {createStaticPreviewService};
