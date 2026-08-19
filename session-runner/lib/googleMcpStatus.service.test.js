"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {googleMcpStatus} = require("./googleMcpStatus.service");

const config = {
  harnessId: "pi",
  googleMcpAccountEmail: "account-a@example.com",
  googleMcpAccountName: "Account A",
  googleMcpConnectionStatus: "connected",
  mcpConfigRaw: JSON.stringify({mcpServers: {
    "google-gmail": {url: "https://gmailmcp.googleapis.com/mcp/v1", authMode: "bearer_env", bearerTokenEnv: "TEST_GOOGLE_TOKEN"},
    "google-drive": {url: "https://drivemcp.googleapis.com/mcp/v1", authMode: "bearer_env", bearerTokenEnv: "TEST_GOOGLE_TOKEN"},
  }}),
};

test("reports safe Pi Google MCP status without credential material", () => {
  const previous = process.env.TEST_GOOGLE_TOKEN;
  process.env.TEST_GOOGLE_TOKEN = "fake-token";
  try {
    const result = googleMcpStatus(config, {existsSync: () => false});
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
    if (previous === undefined) delete process.env.TEST_GOOGLE_TOKEN;
    else process.env.TEST_GOOGLE_TOKEN = previous;
  }
});

test("reports empty supported status without Google configuration", () => {
  assert.deepEqual(googleMcpStatus({harnessId: "codex", mcpConfigRaw: "{}"}), {ok: true, supported: true, servers: []});
});

test("reports reconnect-required state without exposing provider errors", () => {
  assert.equal(googleMcpStatus({...config, googleMcpConnectionStatus: "reconnect_required"}).servers[0].state, "reconnect_required");
});
