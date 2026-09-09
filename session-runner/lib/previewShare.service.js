"use strict";

const fs = require("fs");
const path = require("path");
const {normalizeEnvString, pathExists, safePathInRoot} = require("./utils");
const {contentTypeForPreviewPath, normalizeStoragePrefix} = require("./previewHelpers");

function createPreviewShareService() {
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

  return {shareStaticBuild};
}

function publicError(status, publicMessage) {
  const error = new Error(publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  return error;
}

module.exports = {createPreviewShareService};
