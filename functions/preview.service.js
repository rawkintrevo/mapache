"use strict";

const crypto = require("crypto");
const path = require("path");
const logger = require("firebase-functions/logger");
const {cleanName, httpError} = require("./backendUtils.helpers");

function createPreviewService(dependencies = {}) {
  return {
    createSessionAccessUrls: (uid, workspaceId, sessionId) =>
      createSessionAccessUrls(uid, workspaceId, sessionId, dependencies),
    servePublicPreview: (route, req, res) => servePublicPreview(route, req, res, dependencies),
    shareSessionPreview: (uid, workspaceId, sessionId, req) =>
      shareSessionPreview(uid, workspaceId, sessionId, req, dependencies),
  };
}

async function createSessionAccessUrls(uid, workspaceId, sessionId, dependencies = {}) {
  const {sessionSnap} = await dependencies.requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.browserAccessTokenSecret) {
    throw httpError(409, "session_requires_restart_for_browser_access");
  }

  const expiresAtMs = Date.now() + dependencies.browserAccessTtlMs;
  const token = signSessionBrowserAccessToken(session, expiresAtMs);
  const baseUrl = session.serviceUrl.replace(/\/+$/, "");
  const terminalUrl = appendQuery(`${baseUrl}/`, "mapache_access", token);
  const previewUrl = appendQuery(`${baseUrl}/preview/`, "mapache_access", token);
  const sshForwardBaseUrl = appendQuery(`${baseUrl}/ssh/forward`, "mapache_access", token);
  const browserUrl = session.capabilities && session.capabilities.chrome ?
    appendQuery(`${baseUrl}/browser/`, "mapache_access", token) : null;
  const browserStatusUrl = session.capabilities && session.capabilities.chrome ?
    appendQuery(`${baseUrl}/browser/status`, "mapache_access", token) : null;
  return {
    ok: true,
    expiresAt: new Date(expiresAtMs).toISOString(),
    terminalUrl,
    previewUrl,
    sshForwardBaseUrl,
    browserUrl,
    browserStatusUrl,
  };
}

async function shareSessionPreview(uid, workspaceId, sessionId, req, dependencies = {}) {
  const {sessionSnap} = await dependencies.requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_preview_share_unavailable");
  if (!(session.capabilities && session.capabilities.preview)) {
    throw httpError(400, "session_preview_not_supported");
  }

  const token = crypto.randomBytes(18).toString("base64url");
  const bucketName = session.workspaceStorageBucket || dependencies.defaultBucket;
  const storagePrefix = [
    "public-previews",
    cleanPreviewPathSegment(uid),
    cleanPreviewPathSegment(workspaceId),
    cleanPreviewPathSegment(sessionId),
    token,
  ].join("/");
  const expiresAt = dependencies.admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const shareResult = await dependencies.requestRunnerJson(session, "/preview/share", {
    method: "POST",
    body: {
      bucketName,
      storagePrefix,
    },
    timeoutMs: 120000,
    unavailableError: "runner_preview_share_unavailable",
  });

  const previewDoc = {
    bucketName,
    contentType: "static",
    createdAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
    expiresAt,
    fileCount: shareResult.fileCount || 0,
    indexPath: "index.html",
    ownerUid: uid,
    sessionId,
    sizeBytes: shareResult.sizeBytes || 0,
    storagePrefix,
    updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
    workspaceId,
  };
  await dependencies.db.collection("publicPreviews").doc(token).set(previewDoc);

  const publicUrl = new URL(`/api/public-previews/${token}/`, requestOrigin(req)).toString();
  return {
    ok: true,
    publicUrl,
    expiresAt: expiresAt.toDate().toISOString(),
    fileCount: previewDoc.fileCount,
    sizeBytes: previewDoc.sizeBytes,
  };
}

async function servePublicPreview(route, req, res, dependencies = {}) {
  const token = cleanName(route.token || "");
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(token)) {
    res.status(404).send("preview not found");
    return;
  }

  const snap = await dependencies.db.collection("publicPreviews").doc(token).get();
  if (!snap.exists) {
    res.status(404).send("preview not found");
    return;
  }
  const preview = snap.data();
  if (preview.expiresAt && preview.expiresAt.toMillis && preview.expiresAt.toMillis() <= Date.now()) {
    res.status(410).send("preview expired");
    return;
  }

  const requestedPath = publicPreviewPath(route.path || "index.html");
  if (!requestedPath) {
    res.status(400).send("invalid preview path");
    return;
  }

  const bucket = dependencies.storage.bucket(preview.bucketName || dependencies.defaultBucket);
  let filePath = `${preview.storagePrefix}/${requestedPath}`;
  let file = bucket.file(filePath);
  let exists = (await file.exists())[0];
  if (!exists && shouldServePublicPreviewIndexFallback(req, requestedPath)) {
    filePath = `${preview.storagePrefix}/${preview.indexPath || "index.html"}`;
    file = bucket.file(filePath);
    exists = (await file.exists())[0];
  }
  if (!exists) {
    res.status(404).send("preview file not found");
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("Content-Type", publicPreviewContentType(filePath));
  file.createReadStream()
      .on("error", (error) => {
        logger.error("public preview stream failed", error);
        if (!res.headersSent) res.status(500).send("preview read failed");
      })
      .pipe(res);
}

function signSessionBrowserAccessToken(session, expiresAtMs) {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(expiresAtMs / 1000),
    sid: session.runnerSessionId || session.id || "",
  })).toString("base64url");
  const signature = crypto
      .createHmac("sha256", session.browserAccessTokenSecret)
      .update(payload)
      .digest("base64url");
  return `${payload}.${signature}`;
}

function appendQuery(url, key, value) {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

function requestOrigin(req) {
  const protocol = String(req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim() || "https";
  const host = req.get("x-forwarded-host") || req.get("host") || "localhost";
  return `${protocol}://${host}`;
}

function cleanPreviewPathSegment(value) {
  return cleanName(value).replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function publicPreviewPath(value) {
  const clean = String(value || "index.html").replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(clean);
  if (!normalized || normalized === ".") return "index.html";
  if (normalized === ".." || normalized.startsWith("../")) return "";
  return normalized;
}

function shouldServePublicPreviewIndexFallback(req, requestedPath) {
  if (!path.posix.extname(requestedPath)) return true;
  return String(req.get("accept") || "").includes("text/html");
}

function publicPreviewContentType(filePath) {
  const extension = path.posix.extname(filePath).toLowerCase();
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

module.exports = {
  cleanPreviewPathSegment,
  createPreviewService,
  publicPreviewContentType,
  publicPreviewPath,
  shouldServePublicPreviewIndexFallback,
};
