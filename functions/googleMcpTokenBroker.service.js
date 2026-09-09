"use strict";

const crypto = require("crypto");
const {httpError} = require("./backendUtils.helpers");

const SESSION_STATUS_RUNNING = "running";

function createGoogleMcpTokenBrokerService(dependencies = {}) {
  const connections = dependencies.connectionsService;
  const oauth = dependencies.oauthService;
  const sessionCollection = dependencies.sessionCollection;
  if (!connections || !oauth || typeof sessionCollection !== "function") {
    throw new Error("Google MCP token broker requires connection, OAuth, and session services.");
  }
  return {
    refreshAccessToken: (request) => refreshAccessToken(request, {
      ...dependencies,
      connections,
      oauth,
      sessionCollection,
    }),
  };
}

async function refreshAccessToken(request = {}, dependencies = {}) {
  if (String(request.method || "").toUpperCase() !== "POST") {
    throw httpError(405, "method_not_allowed");
  }
  const workspaceId = cleanId(request.body?.workspaceId, "invalid_workspace");
  const sessionId = cleanId(request.body?.sessionId, "invalid_session");
  const connectionId = cleanId(request.body?.connectionId, "invalid_google_connection_id");
  const sessionSnap = await dependencies.sessionCollection(workspaceId).doc(sessionId).get();
  const session = sessionSnap.exists ? sessionSnap.data() || {} : null;
  const presentedToken = String(request.get?.("x-shutdown-token") || "");
  if (!session || !safeTokenEqual(presentedToken, session.shutdownToken)) {
    throw httpError(404, "not_found");
  }
  if (session.status !== SESSION_STATUS_RUNNING || session.workspaceId !== workspaceId || !session.ownerUid) {
    throw httpError(409, "google_token_refresh_session_unavailable");
  }

  const binding = await dependencies.connections.getGoogleWorkspaceBinding(session.ownerUid, workspaceId);
  if (!binding || binding.connectionId !== connectionId) {
    throw httpError(409, "google_connection_reconnect_required");
  }
  const refreshed = await dependencies.oauth.refreshGoogleConnection(session.ownerUid, connectionId);
  const accessToken = String(refreshed?.accessToken || "").trim();
  if (!accessToken) throw httpError(502, "google_access_token_missing");
  return {
    accessToken,
    expiresIn: Math.max(0, Number(refreshed.expiresIn || 0)),
  };
}

function cleanId(value, errorCode) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw httpError(400, errorCode);
  return id;
}

function safeTokenEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length > 0 &&
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  createGoogleMcpTokenBrokerService,
  refreshAccessToken,
  safeTokenEqual,
};
