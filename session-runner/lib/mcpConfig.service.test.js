"use strict";

const assert = require("assert");
const {
  CHROME_DEVTOOLS_MCP_PACKAGE,
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
