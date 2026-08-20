"use strict";

const assert = require("assert");
const {
  codexMcpToml,
  CHROME_DEVTOOLS_MCP_PACKAGE,
  mergeCodexMcpToml,
  parseMcpConfig,
  piMcpConfig,
  runnerMcpConfig,
} = require("./mcpConfig.service");

assert.strictEqual(CHROME_DEVTOOLS_MCP_PACKAGE, "chrome-devtools-mcp@1.6.0");

assert.deepStrictEqual(parseMcpConfig(JSON.stringify({
  mcpServers: {
    "chrome-devtools": {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
      env: {CHROME_PROFILE: "qa"},
    },
  },
})), {
  mcpServers: {
    "chrome-devtools": {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
      env: {CHROME_PROFILE: "qa"},
    },
  },
});

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

const toml = codexMcpToml({
  mcpServers: {
    context7: {
      url: "https://mcp.context7.com/mcp",
      headers: {AUTHORIZATION: "Bearer CONTEXT7_TOKEN"},
    },
    "chrome-devtools": {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
    },
  },
});
assert.match(toml, /\[mcp_servers\.context7\]/);
assert.match(toml, /url = "https:\/\/mcp\.context7\.com\/mcp"/);
assert.match(toml, /http_headers = \{ AUTHORIZATION = "Bearer CONTEXT7_TOKEN" \}/);
assert.match(toml, /\[mcp_servers\.chrome-devtools\]/);
assert.match(toml, /command = "npx"/);
assert.match(toml, /args = \["-y", "chrome-devtools-mcp@latest"\]/);

const googleConfig = {
  mcpServers: {
    gmail: {
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      authMode: "oauth2",
      oauthClientRef: "google-client-prod",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      headers: {"X-Google-Account": "${GOOGLE_ACCOUNT_REF}"},
      oauthRedirectUri: "https://mapache.example.com/api/google/callback",
      secretRefs: {refreshToken: "GOOGLE_REFRESH_TOKEN"},
    },
    drive: {
      url: "https://drivemcp.googleapis.com/mcp/v1",
      authMode: "bearer_env",
      bearerTokenEnv: "GOOGLE_BEARER_TOKEN",
      protocolVersion: "auto",
    },
  },
};
assert.deepStrictEqual(piMcpConfig(googleConfig), {
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
const googleToml = codexMcpToml(googleConfig);
assert.match(googleToml, /mcp_oauth_credentials_store = "file"/);
assert.match(googleToml, /http_headers|env_http_headers|oauth = \{ client_id = "google-client-prod" \}/);
assert.match(googleToml, /scopes = \["https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly"\]/);
assert.match(googleToml, /bearer_token_env_var = "GOOGLE_BEARER_TOKEN"/);
assert.doesNotMatch(googleToml, /GOOGLE_REFRESH_TOKEN/);
assert.match(googleToml, /env_http_headers = \{ X-Google-Account = "GOOGLE_ACCOUNT_REF" \}/);

const merged = mergeCodexMcpToml("approval_policy = \"never\"\n", {
  mcpServers: {demo: {command: "node"}},
});
assert.match(merged, /^approval_policy = "never"/);
assert.match(merged, /# BEGIN MAPACHE MCP/);
assert.match(merged, /\[mcp_servers\.demo\]/);

const replaced = mergeCodexMcpToml(merged, {
  mcpServers: {next: {command: "node"}},
});
assert.doesNotMatch(replaced, /\[mcp_servers\.demo\]/);
assert.match(replaced, /\[mcp_servers\.next\]/);

console.log("mcp config service tests passed");
