"use strict";

const crypto = require("crypto");

function createBrowserAccessVerifier({secret = "", sessionId = "", now = () => Date.now()} = {}) {
  return {
    extractToken,
    maxAgeMs,
    verify,
  };

  function extractToken(request = {}) {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const queryToken = url.searchParams.get("mapache_access");
      if (queryToken) return queryToken;
    } catch (error) {
      return "";
    }
    const cookie = request.headers && request.headers.cookie || "";
    const match = cookie.match(/(?:^|;\s*)mapache_access=([^;]+)/);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch (error) {
      return "";
    }
  }

  function verify(token) {
    if (!secret) return false;
    const parts = String(token || "").split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest("base64url");
    if (!timingSafeEqual(parts[1], expected)) return false;
    const payload = parsePayload(parts[0]);
    return Boolean(payload && payload.sid === sessionId && Number(payload.exp || 0) > Math.floor(now() / 1000));
  }

  function maxAgeMs(token) {
    const payload = parsePayload(String(token || "").split(".")[0] || "");
    const expMs = Number(payload && payload.exp || 0) * 1000;
    return Math.max(0, Math.min(expMs - now(), 24 * 60 * 60 * 1000));
  }
}

function browserVncWebSocketPath(accessToken) {
  const path = "browser/vnc";
  const token = String(accessToken || "");
  return token ? `${path}?mapache_access=${encodeURIComponent(token)}` : path;
}

function parsePayload(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (error) {
    return null;
  }
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  browserVncWebSocketPath,
  createBrowserAccessVerifier,
  parsePayload,
};
