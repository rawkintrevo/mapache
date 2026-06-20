"use strict";

const assert = require("assert");
const {
  codexMcpToml,
  mergeCodexMcpToml,
  parseMcpConfig,
} = require("./mcpConfig.service");

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
