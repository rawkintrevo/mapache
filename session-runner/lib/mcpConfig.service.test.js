"use strict";

const assert = require("assert");
const {
  codexMcpToml,
  CHROME_DEVTOOLS_MCP_PACKAGE,
  mergeCodexMcpToml,
  parseMcpConfig,
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
assert.match(toml, /headers = \{ AUTHORIZATION = "Bearer CONTEXT7_TOKEN" \}/);
assert.match(toml, /\[mcp_servers\.chrome-devtools\]/);
assert.match(toml, /command = "npx"/);
assert.match(toml, /args = \["-y", "chrome-devtools-mcp@latest"\]/);

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
