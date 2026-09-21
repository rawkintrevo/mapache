"use strict";

const assert = require("assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  AUTOMATION_MCP_SERVER_NAME,
  AUTOMATION_MCP_SERVER_PATH,
  CHROME_DEVTOOLS_MCP_PACKAGE,
  createMcpConfigService,
  parseMcpConfig,
  piMcpConfig,
  runnerMcpConfig,
} = require("./mcpConfig.service");

assert.strictEqual(CHROME_DEVTOOLS_MCP_PACKAGE, "chrome-devtools-mcp@1.6.0");
assert.deepStrictEqual(parseMcpConfig(JSON.stringify({
  mcpServers: {demo: {command: "node", args: ["server.mjs"]}},
})), {mcpServers: {demo: {command: "node", args: ["server.mjs"]}}});
assert.deepStrictEqual(parseMcpConfig("{bad json"), {mcpServers: {}});

const chromeMcp = runnerMcpConfig({
  chromeEnabled: true,
  browserCdpUrl: "http://127.0.0.1:9222",
  mcpConfigRaw: JSON.stringify({mcpServers: {"chrome-devtools": {command: "unsafe"}, demo: {command: "node"}}}),
});
assert.deepStrictEqual(chromeMcp.mcpServers["chrome-devtools"], {
  command: "chrome-devtools-mcp",
  args: ["--browser-url", "http://127.0.0.1:9222", "--no-usage-statistics"],
  env: {CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1"},
});
assert.deepStrictEqual(chromeMcp.mcpServers.demo, {command: "node"});
assert.deepStrictEqual(runnerMcpConfig({chromeEnabled: false, mcpConfigRaw: "{}"}), {mcpServers: {}});

const automationMcp = runnerMcpConfig({
  runtimeKind: "automation",
  automationAgentSocketPath: "/var/lib/mapache/runtimes/run-1/automation-agent.sock",
  chromeEnabled: false,
  mcpConfigRaw: JSON.stringify({mcpServers: {demo: {command: "node"}}}),
});
assert.deepStrictEqual(automationMcp.mcpServers["mapache-automations"], {
  command: "node",
  args: [AUTOMATION_MCP_SERVER_PATH],
  env: {MAPACHE_AUTOMATION_AGENT_SOCKET: "/var/lib/mapache/runtimes/run-1/automation-agent.sock"},
});
const collisionMcp = runnerMcpConfig({
  automationAgentSocketPath: "/tmp/automation.sock",
  chromeEnabled: false,
  mcpConfigRaw: JSON.stringify({mcpServers: {[AUTOMATION_MCP_SERVER_NAME]: {command: "user-server"}}}),
});
assert.equal(collisionMcp.mcpServers[AUTOMATION_MCP_SERVER_NAME].command, "user-server");
assert.equal(collisionMcp.mcpServers[`${AUTOMATION_MCP_SERVER_NAME}-2`].command, "node");

assert.deepStrictEqual(piMcpConfig({
  mcpServers: {
    gmail: {
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      authMode: "oauth2",
      oauthClientRef: "google-client-prod",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      headers: {"X-Google-Account": "${GOOGLE_ACCOUNT_REF}"},
      oauthRedirectUri: "https://mapache.example.com/api/google/callback",
    },
    drive: {
      url: "https://drivemcp.googleapis.com/mcp/v1",
      authMode: "bearer_env",
      bearerTokenEnv: "GOOGLE_BEARER_TOKEN",
      protocolVersion: "auto",
    },
  },
}), {
  mcpServers: {
    gmail: {
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      headers: {"X-Google-Account": "${GOOGLE_ACCOUNT_REF}"},
      auth: "oauth",
      oauth: {
        clientId: "google-client-prod",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        redirectUri: "https://mapache.example.com/api/google/callback",
      },
    },
    drive: {
      url: "https://drivemcp.googleapis.com/mcp/v1",
      auth: "bearer",
      bearerTokenEnv: "GOOGLE_BEARER_TOKEN",
      protocolVersion: "auto",
    },
  },
});

console.log("mcp config service tests passed");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-private-mcp-"));
  const workspaceDir = path.join(root, "workspace");
  const firstPath = path.join(root, "run-1", "agent", "mcp.json");
  const secondPath = path.join(root, "run-2", "agent", "mcp.json");
  await fs.mkdir(workspaceDir, {recursive: true});
  try {
    const first = createMcpConfigService({config: {
      isPrivateRuntime: true,
      mcpConfigRaw: JSON.stringify({mcpServers: {private: {command: "node", env: {TOKEN: "run-1-secret"}}}}),
      piMcpConfigPath: firstPath,
      workspaceDir,
    }});
    const second = createMcpConfigService({config: {
      isPrivateRuntime: true,
      mcpConfigRaw: JSON.stringify({mcpServers: {private: {command: "node", env: {TOKEN: "run-2-secret"}}}}),
      piMcpConfigPath: secondPath,
      workspaceDir,
    }});
    await first.materializeMcpConfig();
    await second.materializeMcpConfig();
    const firstText = await fs.readFile(firstPath, "utf8");
    const secondText = await fs.readFile(secondPath, "utf8");
    assert.match(firstText, /run-1-secret/);
    assert.match(secondText, /run-2-secret/);
    assert.equal(firstText.includes("run-2-secret"), false);
    assert.equal(secondText.includes("run-1-secret"), false);
    await assert.rejects(fs.access(path.join(workspaceDir, ".mcp.json")), {code: "ENOENT"});
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
