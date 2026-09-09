"use strict";

const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");

const GOOGLE_SERVICES = Object.freeze(["gmail", "drive", "docs", "sheets", "slides", "calendar"]);
const LOCAL_SERVER_COMMAND = "node";
const LOCAL_SERVER_PATH = "/app/google-workspace-mcp/server.mjs";
const ACCESS_TOKEN_ENV = "GOOGLE_MCP_ACCESS_TOKEN";

function createGoogleMcpStatusService({config, fsImpl = fs, probeLocal = probeLocalMcp} = {}) {
  return {status: () => googleMcpStatus(config, fsImpl, {probeLocal})};
}

async function googleMcpStatus(config = {}, fsImpl = fs, {probeLocal = probeLocalMcp} = {}) {
  const parsed = parseMcpConfig(config.mcpConfigRaw);
  const localServer = findLocalServer(parsed);
  if (localServer) {
    const state = await localConnectionState(config, localServer, probeLocal);
    return {
      ok: true,
      supported: true,
      servers: enabledServices(config).map((serviceKey) => ({
        serviceKey,
        state,
        account: safeAccount(config),
        adapter: config.harnessId === "codex" ? "codex" : "pi",
      })),
    };
  }

  const servers = GOOGLE_SERVICES
      .map((serviceKey) => ({serviceKey, server: findHostedServer(parsed, serviceKey)}))
      .filter(({server}) => server)
      .map(({serviceKey, server}) => ({
        serviceKey,
        state: hostedConnectionState(config, server, fsImpl),
        account: safeAccount(config),
        adapter: config.harnessId === "codex" ? "codex" : "pi",
      }));
  return {ok: true, supported: true, servers};
}

async function localConnectionState(config, server, probeLocal) {
  if (String(config.googleMcpConnectionStatus || "").trim().toLowerCase() === "reconnect_required") return "reconnect_required";
  if (String(process.env[ACCESS_TOKEN_ENV] || "").trim() === "") return "expired";
  try {
    const result = await probeLocal(server, {config});
    return result?.ok ? "connected" : "local_server_failed";
  } catch (error) {
    return "local_server_failed";
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
  const child = spawnImpl(LOCAL_SERVER_COMMAND, [LOCAL_SERVER_PATH], {
    cwd: path.dirname(LOCAL_SERVER_PATH),
    env: process.env,
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
      else if (message.id === 2) finish({ok: !message.error && Array.isArray(message.result?.tools)});
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
