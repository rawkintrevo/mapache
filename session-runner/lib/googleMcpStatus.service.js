"use strict";

const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");

const GOOGLE_SERVICES = Object.freeze(["gmail", "drive", "docs", "sheets", "slides", "calendar"]);
const LOCAL_SERVER_COMMAND = "node";
const LOCAL_SERVER_PATH = "/app/google-workspace-mcp/server.mjs";
const ACCESS_TOKEN_ENV = "GOOGLE_MCP_ACCESS_TOKEN";

function createGoogleMcpStatusService({config, fsImpl = fs, probeLocal = probeLocalMcp, cacheMs = 15000, now = () => Date.now()} = {}) {
  let cached = null;
  let inFlight = null;
  return {status: () => {
    if (cached && now() - cached.at < cacheMs) return Promise.resolve(cached.value);
    if (!inFlight) {
      inFlight = googleMcpStatus(config, fsImpl, {probeLocal})
          .then((value) => {
            cached = {at: now(), value};
            return value;
          })
          .finally(() => { inFlight = null; });
    }
    return inFlight;
  }};
}

async function googleMcpStatus(config = {}, fsImpl = fs, {probeLocal = probeLocalMcp} = {}) {
  const parsed = parseMcpConfig(config.mcpConfigRaw);
  const localServer = findLocalServer(parsed);
  if (localServer) {
    const local = await localConnectionState(config, localServer, probeLocal);
    return {
      ok: local.ok,
      supported: true,
      processReady: local.processReady,
      servers: enabledServices(config).map((serviceKey) => ({
        serviceKey,
        state: local.services?.[serviceKey]?.state || local.state,
        account: safeAccount(config),
        adapter: "pi",
        ...(local.services?.[serviceKey] ? {verification: local.services[serviceKey]} : {}),
      })),
      ...(local.checkedAt ? {checkedAt: local.checkedAt} : {}),
    };
  }

  const servers = GOOGLE_SERVICES
      .map((serviceKey) => ({serviceKey, server: findHostedServer(parsed, serviceKey)}))
      .filter(({server}) => server)
      .map(({serviceKey, server}) => ({
        serviceKey,
        state: hostedConnectionState(config, server, fsImpl),
        account: safeAccount(config),
        adapter: "pi",
      }));
  return {ok: true, supported: true, servers};
}

async function localConnectionState(config, server, probeLocal) {
  if (String(config.googleMcpConnectionStatus || "").trim().toLowerCase() === "reconnect_required") return {ok: false, state: "reconnect_required", processReady: false};
  if (String(process.env[ACCESS_TOKEN_ENV] || "").trim() === "") return {ok: false, state: "expired", processReady: false};
  try {
    const result = await probeLocal(server, {config});
    if (result?.health?.services) {
      return {ok: result.ok === true, state: result.ok ? "connected" : "local_server_failed", processReady: result.health.processReady === true, services: result.health.services, checkedAt: result.health.checkedAt};
    }
    return result?.ok ? {ok: true, state: "connected", processReady: true} : {ok: false, state: "local_server_failed", processReady: false};
  } catch (error) {
    return {ok: false, state: "local_server_failed", processReady: false};
  }
}

function hostedConnectionState(config, server, fsImpl) {
  if (String(config.googleMcpConnectionStatus || "").trim().toLowerCase() === "reconnect_required") return "reconnect_required";
  if (String(config.googleMcpConnectionStatus || "").trim().toLowerCase() === "expired") return "expired";
  const bearerEnv = String(server.bearerTokenEnv || "").trim();
  if (bearerEnv && process.env[bearerEnv]) return "connected";
  if (server.authMode === "oauth2" && oauthCredentialStoreExists(config, fsImpl)) return "connected";
  return "configured";
}

async function probeLocalMcp(server, {config = {}, spawnImpl = spawn, timeoutMs = 2_000} = {}) {
  if (!isLocalServer(server)) return {ok: false, reason: "local_server_not_configured"};
  const childEnv = {...process.env};
  delete childEnv.SESSION_SHUTDOWN_TOKEN;
  delete childEnv.GOOGLE_MCP_TOKEN_REFRESH_URL;
  delete childEnv.GOOGLE_MCP_CONNECTION_ID;
  delete childEnv.GOOGLE_MCP_TOKEN_SOCKET_PATH;
  if (config.googleMcpTokenSocketPath) childEnv.GOOGLE_MCP_TOKEN_SOCKET = config.googleMcpTokenSocketPath;
  else delete childEnv.GOOGLE_MCP_TOKEN_SOCKET;
  const child = spawnImpl(LOCAL_SERVER_COMMAND, [LOCAL_SERVER_PATH], {
    cwd: path.dirname(LOCAL_SERVER_PATH),
    env: childEnv,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.removeAllListeners?.("data");
      child.removeAllListeners?.("exit");
      child.removeAllListeners?.("error");
      child.kill?.("SIGTERM");
      resolve(result);
    };
    const send = (message) => child.stdin?.write(JSON.stringify(message) + "\n");
    const handleMessage = (message) => {
      if (message.id === 1) send({jsonrpc: "2.0", method: "notifications/initialized", params: {}}), send({jsonrpc: "2.0", id: 2, method: "tools/list", params: {}});
      else if (message.id === 2) {
        if (message.error || !Array.isArray(message.result?.tools)) return finish({ok: false});
        send({jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: "google_workspace_health", arguments: {}}});
      } else if (message.id === 3) {
        const health = message.result?.structuredContent || parseHealthContent(message.result?.content);
        finish({ok: health?.ok === true, health});
      }
    };
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { handleMessage(JSON.parse(line)); } catch (error) { finish({ok: false}); }
      }
    });
    child.on?.("error", () => finish({ok: false}));
    child.on?.("exit", () => finish({ok: false}));
    const timeout = setTimeout(() => finish({ok: false}), timeoutMs);
    send({jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "mapache-health", version: "0.1.0"}}});
  });
}

function parseHealthContent(content) {
  const text = Array.isArray(content) ? content.find((item) => item?.type === "text")?.text : "";
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function parseMcpConfig(rawConfig) {
  try {
    const parsed = JSON.parse(String(rawConfig || "{}"));
    return parsed && parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed : {mcpServers: {}};
  } catch (error) {
    return {mcpServers: {}};
  }
}

function findLocalServer(parsed) {
  return Object.values(parsed.mcpServers || {}).find(isLocalServer) || null;
}

function isLocalServer(server) {
  return server && server.command === LOCAL_SERVER_COMMAND && Array.isArray(server.args) && server.args.length === 1 && server.args[0] === LOCAL_SERVER_PATH;
}

function findHostedServer(parsed, serviceKey) {
  const url = `https://${serviceKey === "people" ? "people" : `${serviceKey}mcp`}.googleapis.com/mcp/v1`;
  return Object.values(parsed.mcpServers || {}).find((server) => server && server.url === url) || null;
}

function enabledServices(config) {
  try {
    const parsed = JSON.parse(String(config.googleMcpEnabledServices || process.env.GOOGLE_MCP_ENABLED_SERVICES || "[]"));
    return [...new Set((Array.isArray(parsed) ? parsed : []).map((value) => String(value || "").trim().toLowerCase()).filter((value) => GOOGLE_SERVICES.includes(value)))];
  } catch (error) {
    return [];
  }
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

module.exports = {createGoogleMcpStatusService, googleMcpStatus, probeLocalMcp};
