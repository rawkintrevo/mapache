"use strict";

const {httpError} = require("./backendUtils.helpers");
const {googleWorkspaceServiceCatalog} = require("./googleWorkspace.catalog");
const {normalizeMcpConfigPayload} = require("./mcpConfig.helpers");

const ACCESS_TOKEN_ENV = "GOOGLE_MCP_ACCESS_TOKEN";

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

  const connection = await dependencies.connections.getGoogleConnection(uid, binding.connectionId, {includePrivate: false});
  if (connection.status !== "connected") throw httpError(409, "google_connection_reconnect_required");
  const refreshed = await dependencies.oauth.refreshGoogleConnection(uid, binding.connectionId);
  if (!refreshed.accessToken) throw httpError(502, "google_access_token_missing");

  const services = googleWorkspaceServiceCatalog().filter((service) => binding.enabledServices.includes(service.key));
  if (!services.length) throw httpError(409, "google_service_binding_empty");
  const googleServers = Object.fromEntries(services.map((service) => [
    `google-${service.key}`,
    {
      url: service.serverUrl,
      authMode: "bearer_env",
      bearerTokenEnv: ACCESS_TOKEN_ENV,
      protocolVersion: "auto",
      scopes: service.readScopes,
    },
  ]));
  return {
    mcpConfig: normalizeMcpConfigPayload({mcpServers: {...base.mcpServers, ...googleServers}}),
    env: {
      [ACCESS_TOKEN_ENV]: refreshed.accessToken,
      GOOGLE_MCP_CONNECTION_STATUS: "connected",
      GOOGLE_MCP_ACCOUNT_EMAIL: connection.email || "",
      GOOGLE_MCP_ACCOUNT_NAME: connection.displayName || "",
      GOOGLE_MCP_ENABLED_SERVICES: JSON.stringify(services.map((service) => service.key)),
    },
    connection: {
      connectionId: connection.connectionId,
      email: connection.email,
      displayName: connection.displayName,
      enabledServices: services.map((service) => service.key),
    },
  };
}

module.exports = {
  ACCESS_TOKEN_ENV,
  createGoogleWorkspaceProvisioningService,
  resolveGoogleMcpRuntime,
};
