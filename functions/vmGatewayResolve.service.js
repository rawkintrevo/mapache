"use strict";

const {createHmac, timingSafeEqual} = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");

// Called only by the IAM-authenticated gateway. No browser-facing Firestore API.
function createVmGatewayResolveService({db, now = Date.now}) {
  return async function resolve(req) {
    if (req.method !== "POST") throw httpError(405, "method_not_allowed");
    const {host, path, token, shutdownToken, origin} = req.body || {};
    if (Buffer.byteLength(JSON.stringify(req.body || {})) > 16384 ||
        typeof host !== "string" || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(host) ||
        typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") ||
        path.includes("\\") || /[\x00-\x20\x7f]/.test(path)) throw httpError(400, "invalid_gateway_request");
    // Cookie-bearing cross-origin writes/WebSockets must never reach the runner.
    if (origin && origin !== `https://${host}`) throw httpError(404, "not_found");
    return db.runTransaction(async (tx) => {
      const route = (await tx.get(db.collection("vmGatewayRoutes_v2").doc(host))).data();
      if (!route?.workspaceId || route.enabled !== true) throw httpError(404, "not_found");
      const workspaceRef = db.collection("vmRuntimes_v2").doc(route.workspaceId);
      const ws = (await tx.get(workspaceRef)).data();
      if (!ws?.currentSessionId || ws.backend !== "compute-engine") throw httpError(404, "not_found");
      const [ss, cs] = await Promise.all([
        tx.get(workspaceRef.collection("sessions").doc(ws.currentSessionId)),
        tx.get(db.collection("vmRuntimeCredentials_v2").doc(ws.currentSessionId)),
      ]);
      const session = ss.data();
      const credentials = cs.data();
      const time = now();
      if (!session || !credentials || !ws.ownerUid || route.ownerUid !== ws.ownerUid ||
          session.ownerUid !== ws.ownerUid || credentials.ownerUid !== ws.ownerUid ||
          session.generation !== ws.generation || credentials.generation !== ws.generation ||
          route.generation !== ws.generation || route.sessionId !== ws.currentSessionId ||
          ws.state !== "active" || session.state !== "active" || !ws.bootId || ws.bootId !== session.bootId ||
          !(ws.leaseExpiresAt > time) || !(session.leaseExpiresAt > time)) throw httpError(404, "not_found");
      let expiresAt;
      if (path === "/runner/health") {
        if (!safeEqual(shutdownToken, credentials.shutdownToken)) throw httpError(404, "not_found");
        expiresAt = time + 30000;
      } else {
        const payload = verifyToken(token, credentials.browserToken, time);
        if (!payload || payload.sid !== ws.currentSessionId ||
            (payload.gen !== undefined && String(payload.gen) !== String(ws.generation)) ||
            (payload.aud !== undefined && payload.aud !== "agent")) throw httpError(404, "not_found");
        // URL normalization prevents encoded traversal from weakening agent checks.
        let pathname;
        try { pathname = new URL(decodeURIComponent(path), "https://gateway.invalid").pathname; } catch {
          throw httpError(400, "invalid_gateway_request");
        }
        if ((pathname === "/agent" || pathname.startsWith("/agent/")) &&
            (payload.aud !== "agent" || String(payload.gen) !== String(ws.generation))) throw httpError(404, "not_found");
        expiresAt = payload.exp * 1000;
      }
      // Targets are written by the controller, never supplied by a client or runner.
      if (!isVmAddress(route.address)) throw httpError(503, "gateway_target_unavailable");
      return {address: route.address, port: 8080, sessionId: ws.currentSessionId,
        generation: ws.generation, bootId: ws.bootId,
        validUntil: Math.min(time + 10000, expiresAt, ws.leaseExpiresAt, session.leaseExpiresAt)};
    });
  };
}

function isVmAddress(address) {
  return typeof address === "string" && /^10\.90\.0\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(address);
}

function safeEqual(value, expected) {
  if (typeof value !== "string" || typeof expected !== "string" || !expected || value.length > 4096) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifyToken(token, secret, time) {
  if (typeof token !== "string" || token.length > 4096 || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !safeEqual(parts[1], createHmac("sha256", secret).update(parts[0]).digest("base64url"))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    return Number.isSafeInteger(payload.exp) && payload.exp * 1000 > time ? payload : null;
  } catch { return null; }
}

module.exports = {createVmGatewayResolveService, isVmAddress};
