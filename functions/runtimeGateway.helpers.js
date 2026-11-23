"use strict";

const {httpError} = require("./backendUtils.helpers");

const CANONICAL_HEALTH_PATH = "/runner/health";

function normalizeGatewayTarget(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw httpError(409, "runtime_gateway_target_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw httpError(409, "runtime_gateway_target_invalid");
  }
  return url.origin;
}

function authorizeGatewayRequest({claims = {}, workspace = {}, session = {}, path = "/", method = "GET"} = {}) {
  if (!claims.uid || claims.uid !== workspace.ownerUid || claims.workspaceId !== workspace.id || claims.sessionId !== session.id) {
    throw httpError(403, "runtime_gateway_forbidden");
  }
  if (String(claims.generation || "") !== String(session.agentRuntimeGeneration || session.runtimeProvider?.generation || "")) {
    throw httpError(409, "runtime_gateway_stale_generation");
  }
  const normalizedPath = `/${String(path || "").replace(/^\/+/, "")}`;
  const reservedHealthPath = `/${["health", "z"].join("")}`;
  if (normalizedPath === reservedHealthPath || normalizedPath === `${reservedHealthPath}/`) throw httpError(404, "not_found");
  return {
    allowed: true,
    method: String(method || "GET").toUpperCase(),
    path: normalizedPath,
    health: normalizedPath === CANONICAL_HEALTH_PATH,
    upstream: null,
  };
}

function gatewayTargetForSession(session = {}) {
  const target = session.runtimeProvider?.gateway?.baseUrl;
  return target ? normalizeGatewayTarget(target) : null;
}

module.exports = {CANONICAL_HEALTH_PATH, authorizeGatewayRequest, gatewayTargetForSession, normalizeGatewayTarget};
