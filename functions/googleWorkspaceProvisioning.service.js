"use strict";

const {httpError} = require("./backendUtils.helpers");
const {googleWorkspaceServiceCatalog} = require("./googleWorkspace.catalog");
const {normalizeMcpConfigPayload} = require("./mcpConfig.helpers");

const ACCESS_TOKEN_ENV = "GOOGLE_MCP_ACCESS_TOKEN";
const ENABLED_SERVICES_ENV = "GOOGLE_MCP_ENABLED_SERVICES";
const GRANTED_SCOPES_ENV = "GOOGLE_MCP_GRANTED_SCOPES";
const LOCAL_MCP_COMMAND = "node";
const LOCAL_MCP_ARGS = Object.freeze(["/app/google-workspace-mcp/server.mjs"]);
const LOCAL_SERVICE_KEYS = new Set(["calendar", "gmail", "drive", "docs", "sheets", "slides"]);

function createGoogleWorkspaceProvisioningService(dependencies = {}) {
  const connections = dependencies.connectionsService;
  const oauth = dependencies.oauthService;
  if (!connections || !oauth) throw new Error("Google Workspace provisioning service requires connection and OAuth services.");
  return {
    resolveGoogleMcpRuntime: (uid, workspaceId, mcpConfig) =>
      resolveGoogleMcpRuntime(uid, workspaceId, mcpConfig, {...dependencies, connections, oauth}),
  };
}

async function resolveGoogleMcpRuntime(uid, workspaceId, mcpConfig = {}, dependencies = {}) {
  const binding = await dependencies.connections.getGoogleWorkspaceBinding(uid, workspaceId);
  const base = normalizeMcpConfigPayload({mcpServers: mcpConfig.mcpServers || {}});
  if (!binding) return {mcpConfig: base, env: {}};

  const connectionRecord = await dependencies.connections.getGoogleConnection(uid, binding.connectionId, {includePrivate: true});
  const connection = connectionRecord?.metadata || connectionRecord;
  if (connection.status !== "connected") throw httpError(409, "google_connection_reconnect_required");
  const refreshed = await dependencies.oauth.refreshGoogleConnection(uid, binding.connectionId);
  if (!refreshed.accessToken) throw httpError(502, "google_access_token_missing");

  const services = googleWorkspaceServiceCatalog().filter((service) =>
    binding.enabledServices.includes(service.key) && LOCAL_SERVICE_KEYS.has(service.key));
  if (!services.length) throw httpError(409, "google_service_binding_empty");
  const grantedScopes = normalizeGrantedScopes(connection.grantedScopes, services);
  return {
    mcpConfig: normalizeMcpConfigPayload({mcpServers: {
      ...base.mcpServers,
      "google-workspace": {
        command: LOCAL_MCP_COMMAND,
        args: [...LOCAL_MCP_ARGS],
      },
    }}),
    env: {
      [ACCESS_TOKEN_ENV]: refreshed.accessToken,
      GOOGLE_MCP_CONNECTION_STATUS: "connected",
      GOOGLE_MCP_ACCOUNT_EMAIL: connection.email || "",
      GOOGLE_MCP_ACCOUNT_NAME: connection.displayName || "",
      [ENABLED_SERVICES_ENV]: JSON.stringify(services.map((service) => service.key)),
      [GRANTED_SCOPES_ENV]: JSON.stringify(grantedScopes),
    },
    connection: {
      connectionId: connection.connectionId,
      email: connection.email,
      displayName: connection.displayName,
      enabledServices: services.map((service) => service.key),
    },
  };
}

function normalizeGrantedScopes(value, services) {
  const scopes = Array.isArray(value) ? value.map((scope) => String(scope || "").trim()).filter(Boolean) : [];
  if (scopes.length) return [...new Set(scopes)];
  return [...new Set(services.flatMap((service) => service.readScopes))];
}

module.exports = {
  ACCESS_TOKEN_ENV,
  ENABLED_SERVICES_ENV,
  GRANTED_SCOPES_ENV,
  LOCAL_MCP_ARGS,
  LOCAL_MCP_COMMAND,
  createGoogleWorkspaceProvisioningService,
  resolveGoogleMcpRuntime,
};
