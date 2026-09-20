"use strict";

const fs = require("fs/promises");
const fsNative = require("node:fs");
const path = require("path");
const {ensurePrivateRuntimeDirectory} = require("./runtimeStorage.helpers");

const CHROME_DEVTOOLS_MCP_PACKAGE = "chrome-devtools-mcp@1.6.0";
const AUTOMATION_MCP_SERVER_NAME = "mapache-automations";
const AUTOMATION_MCP_SERVER_PATH = "/app/automation-mcp/server.mjs";

function parseMcpConfig(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    const servers = parsed && parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers) ?
      parsed.mcpServers :
      {};
    return {mcpServers: servers};
  } catch (error) {
    console.error("invalid MCP_CONFIG, ignoring MCP servers", error);
    return {mcpServers: {}};
  }
}

function createMcpConfigService({config}) {
  const mcpConfig = runnerMcpConfig(config);
  const outputPath = mcpConfigPath(config);

  async function materializeMcpConfig(harness = null) {
    await writeJsonFile(outputPath, piMcpConfig(mcpConfig), config);
    return {
      ok: true,
      harness: harness?.id || "pi",
      serverCount: Object.keys(mcpConfig.mcpServers).length,
    };
  }

  return {materializeMcpConfig};
}

function mcpConfigPath(config = {}) {
  if (config.piMcpConfigPath) return path.resolve(config.piMcpConfigPath);
  if (config.isPrivateRuntime) return path.join(config.piAgentDir, "mcp.json");
  return path.join(config.workspaceDir, ".mcp.json");
}

function runnerMcpConfig(config = {}) {
  const parsed = parseMcpConfig(config.mcpConfigRaw);
  const mcpServers = {...parsed.mcpServers};
  if (config.automationAgentSocketPath) {
    const name = uniqueManagedServerName(mcpServers, AUTOMATION_MCP_SERVER_NAME);
    mcpServers[name] = {
      command: "node",
      args: [AUTOMATION_MCP_SERVER_PATH],
      env: {MAPACHE_AUTOMATION_AGENT_SOCKET: config.automationAgentSocketPath},
    };
  }
  if (!config.chromeEnabled && !config.runnerCapabilities?.chrome) return {mcpServers};
  return {
    mcpServers: {
      ...mcpServers,
      "chrome-devtools": {
        command: "chrome-devtools-mcp",
        args: ["--browser-url", config.browserCdpUrl || "http://127.0.0.1:9222", "--no-usage-statistics"],
        env: {CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1"},
      },
    },
  };
}

function uniqueManagedServerName(servers, baseName) {
  if (!Object.prototype.hasOwnProperty.call(servers, baseName)) return baseName;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${baseName}-${suffix}`;
    if (!Object.prototype.hasOwnProperty.call(servers, candidate)) return candidate;
  }
  throw new Error("automation_mcp_server_name_unavailable");
}

function piMcpConfig(mcpConfig = {}) {
  return {
    mcpServers: Object.fromEntries(Object.entries(mcpConfig.mcpServers || {}).map(([name, server]) => [
      name,
      piMcpServer(server),
    ])),
  };
}

function piMcpServer(server = {}) {
  const result = {};
  for (const key of ["command", "args", "env", "url", "cwd", "headers", "lifecycle", "directTools", "protocolVersion"]) {
    if (server[key] != null) result[key] = server[key];
  }
  if (server.authMode === "oauth2") {
    result.auth = "oauth";
    result.oauth = {
      ...(server.oauthClientRef ? {clientId: server.oauthClientRef} : {}),
      ...(server.scopes?.length ? {scope: server.scopes.join(" ")} : {}),
      ...(server.oauthRedirectUri ? {redirectUri: server.oauthRedirectUri} : {}),
      ...(server.secretRefs?.clientSecret ? {clientSecret: `\${${server.secretRefs.clientSecret}}`} : {}),
    };
  } else if (server.authMode === "bearer_env") {
    result.auth = "bearer";
    if (server.bearerTokenEnv) result.bearerTokenEnv = server.bearerTokenEnv;
  }
  return result;
}

async function writeJsonFile(filePath, value, config = {}) {
  if (config.isPrivateRuntime) {
    await ensurePrivateRuntimeDirectory(path.dirname(filePath), {fsImpl: fsNative});
  }
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", {encoding: "utf8", mode: 0o600});
  await fs.chmod(filePath, 0o600).catch(() => {});
}

module.exports = {
  AUTOMATION_MCP_SERVER_NAME,
  AUTOMATION_MCP_SERVER_PATH,
  CHROME_DEVTOOLS_MCP_PACKAGE,
  createMcpConfigService,
  mcpConfigPath,
  parseMcpConfig,
  piMcpConfig,
  piMcpServer,
  runnerMcpConfig,
  uniqueManagedServerName,
};
