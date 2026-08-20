"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {googleMcpStatus} = require("./googleMcpStatus.service");

const localConfig = {
  harnessId: "pi",
  googleMcpAccountEmail: "account-a@example.com",
  googleMcpAccountName: "Account A",
  googleMcpConnectionStatus: "connected",
  googleMcpEnabledServices: "[\"gmail\",\"drive\"]",
  mcpConfigRaw: JSON.stringify({mcpServers: {"google-workspace": {command: "node", args: ["/app/google-workspace-mcp/server.mjs"]}}}),
};

test("reports connected only after local MCP readiness evidence", async () => {
  const previous = process.env.GOOGLE_MCP_ACCESS_TOKEN;
  process.env.GOOGLE_MCP_ACCESS_TOKEN = "fake-token";
  try {
    const result = await googleMcpStatus(localConfig, {}, {probeLocal: async () => ({ok: true})});
    assert.deepEqual(result, {
      ok: true,
      supported: true,
      servers: [
        {serviceKey: "gmail", state: "connected", account: {email: "account-a@example.com", displayName: "Account A"}, adapter: "pi"},
        {serviceKey: "drive", state: "connected", account: {email: "account-a@example.com", displayName: "Account A"}, adapter: "pi"},
      ],
    });
    assert.equal(JSON.stringify(result).includes("fake-token"), false);
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_MCP_ACCESS_TOKEN;
    else process.env.GOOGLE_MCP_ACCESS_TOKEN = previous;
  }
});

test("reports expired, reconnect-required, and local-server-failed states", async () => {
  const previous = process.env.GOOGLE_MCP_ACCESS_TOKEN;
  delete process.env.GOOGLE_MCP_ACCESS_TOKEN;
  assert.equal((await googleMcpStatus(localConfig, {}, {probeLocal: async () => ({ok: true})})).servers[0].state, "expired");
  process.env.GOOGLE_MCP_ACCESS_TOKEN = "fake-token";
  assert.equal((await googleMcpStatus({...localConfig, googleMcpConnectionStatus: "reconnect_required"}, {}, {probeLocal: async () => ({ok: true})})).servers[0].state, "reconnect_required");
  assert.equal((await googleMcpStatus(localConfig, {}, {probeLocal: async () => ({ok: false})})).servers[0].state, "local_server_failed");
  if (previous === undefined) delete process.env.GOOGLE_MCP_ACCESS_TOKEN;
  else process.env.GOOGLE_MCP_ACCESS_TOKEN = previous;
});

test("keeps hosted compatibility status safe", async () => {
  const previous = process.env.TEST_GOOGLE_TOKEN;
  process.env.TEST_GOOGLE_TOKEN = "fake-token";
  try {
    const result = await googleMcpStatus({harnessId: "codex", googleMcpConnectionStatus: "connected", mcpConfigRaw: JSON.stringify({mcpServers: {"google-gmail": {url: "https://gmailmcp.googleapis.com/mcp/v1", authMode: "bearer_env", bearerTokenEnv: "TEST_GOOGLE_TOKEN"}}})}, {existsSync: () => false});
    assert.equal(result.servers[0].state, "connected");
    assert.equal(JSON.stringify(result).includes("fake-token"), false);
  } finally {
    if (previous === undefined) delete process.env.TEST_GOOGLE_TOKEN;
    else process.env.TEST_GOOGLE_TOKEN = previous;
  }
});

test("reports empty status without Google configuration", async () => {
  assert.deepEqual(await googleMcpStatus({harnessId: "codex", mcpConfigRaw: "{}"}), {ok: true, supported: true, servers: []});
});
