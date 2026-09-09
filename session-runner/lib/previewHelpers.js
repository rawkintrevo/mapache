"use strict";

const path = require("path");

function appendAccessToken(url, accessToken) {
  const token = String(accessToken || "").trim();
  if (!token) return url;
  const separator = String(url || "").includes("?") ? "&" : "?";
  return `${url}${separator}mapache_access=${encodeURIComponent(token)}`;
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

function escapeHtml(value) {
  return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

function normalizeStoragePrefix(value) {
  return String(value || "")
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .join("/");
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

module.exports = {
  appendAccessToken,
  contentTypeForPreviewPath,
  escapeHtml,
  normalizeStoragePrefix,
  safePreviewPath,
  shouldServePreviewIndexFallback,
};
