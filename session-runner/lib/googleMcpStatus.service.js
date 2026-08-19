"use strict";

const fs = require("fs");

const GOOGLE_SERVICES = Object.freeze([
  ["gmail", "https://gmailmcp.googleapis.com/mcp/v1"],
  ["drive", "https://drivemcp.googleapis.com/mcp/v1"],
  ["docs", "https://docsmcp.googleapis.com/mcp/v1"],
  ["sheets", "https://sheetsmcp.googleapis.com/mcp/v1"],
  ["slides", "https://slidesmcp.googleapis.com/mcp/v1"],
  ["calendar", "https://calendarmcp.googleapis.com/mcp/v1"],
  ["chat", "https://chatmcp.googleapis.com/mcp/v1"],
  ["people", "https://people.googleapis.com/mcp/v1"],
]);

function createGoogleMcpStatusService({config, fsImpl = fs} = {}) {
  return {status: () => googleMcpStatus(config, fsImpl)};
}

function googleMcpStatus(config = {}, fsImpl = fs) {
  const servers = GOOGLE_SERVICES
      .map(([serviceKey, url]) => ({serviceKey, server: findServer(config.mcpConfigRaw, url)}))
      .filter(({server}) => server)
      .map(({serviceKey, server}) => ({
        serviceKey,
        state: connectionState(config, server, fsImpl),
        account: safeAccount(config),
        adapter: config.harnessId === "codex" ? "codex" : "pi",
      }));
  return {ok: true, supported: true, servers};
}

function findServer(rawConfig, url) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawConfig || "{}"));
  } catch (error) {
    return null;
  }
  const servers = parsed && parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
  return Object.values(servers).find((server) => server && server.url === url) || null;
}

function connectionState(config, server, fsImpl) {
  if (String(config.googleMcpConnectionStatus || "").trim().toLowerCase() === "reconnect_required") {
    return "reconnect_required";
  }
  const bearerEnv = String(server.bearerTokenEnv || "").trim();
  if (bearerEnv && process.env[bearerEnv]) return "connected";
  if (server.authMode === "oauth2" && oauthCredentialStoreExists(config, fsImpl)) return "connected";
  return "configured";
}

function oauthCredentialStoreExists(config, fsImpl) {
  const root = config.piAgentDir || "";
  return Boolean(root && typeof fsImpl.existsSync === "function" && fsImpl.existsSync(`${root}/mcp-oauth`));
}

function safeAccount(config) {
  const email = String(config.googleMcpAccountEmail || "").trim();
  const displayName = String(config.googleMcpAccountName || "").trim();
  return email || displayName ? {email: email || null, displayName: displayName || null} : null;
}

module.exports = {createGoogleMcpStatusService, googleMcpStatus};
