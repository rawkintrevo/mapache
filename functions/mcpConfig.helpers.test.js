"use strict";

const assert = require("assert");
const {
  mcpConfigForRunner,
  normalizeMcpConfigPayload,
} = require("./mcpConfig.helpers");

assert.deepStrictEqual(normalizeMcpConfigPayload({
  servers: [{
    name: "chrome-devtools",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
    env: {CHROME_PROFILE: "qa"},
    lifecycle: "lazy",
  }],
}), {
  version: 1,
  mcpServers: {
    "chrome-devtools": {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
      env: {CHROME_PROFILE: "qa"},
      lifecycle: "lazy",
    },
  },
});

assert.deepStrictEqual(normalizeMcpConfigPayload({
  mcpServers: {
    context7: {
      url: "https://mcp.context7.com/mcp",
      headers: {AUTHORIZATION: "Bearer CONTEXT7_TOKEN"},
    },
  },
}), {
  version: 1,
  mcpServers: {
    context7: {
      url: "https://mcp.context7.com/mcp",
      headers: {AUTHORIZATION: "Bearer CONTEXT7_TOKEN"},
    },
  },
});

assert.throws(() => normalizeMcpConfigPayload({servers: [{name: "Bad Name", command: "npx"}]}), /invalid_mcp_server_name/);
assert.throws(() => normalizeMcpConfigPayload({servers: [{name: "x"}]}), /missing_mcp_server_transport/);
assert.throws(() => normalizeMcpConfigPayload({servers: [{name: "x", command: "npx", url: "http://localhost"}]}), /multiple_mcp_server_transports/);
assert.deepStrictEqual(mcpConfigForRunner({mcpConfig: {mcpServers: {demo: {command: "node"}}}}), {
  version: 1,
  mcpServers: {demo: {command: "node", args: []}},
});

console.log("mcp config helper tests passed");
