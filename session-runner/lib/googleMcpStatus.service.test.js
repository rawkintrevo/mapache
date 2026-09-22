"use strict";

const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const test = require("node:test");
const {googleMcpStatus, probeLocalMcp} = require("./googleMcpStatus.service");

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
      processReady: true,
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
  const result = await googleMcpStatus({harnessId: "pi", googleMcpConnectionStatus: "connected", mcpConfigRaw: JSON.stringify({mcpServers: {"google-gmail": {url: "https://gmailmcp.googleapis.com/mcp/v1", authMode: "bearer_env", bearerTokenEnv: "TEST_GOOGLE_TOKEN"}}})}, {existsSync: () => false});
    assert.equal(result.servers[0].state, "connected");
    assert.equal(JSON.stringify(result).includes("fake-token"), false);
  } finally {
    if (previous === undefined) delete process.env.TEST_GOOGLE_TOKEN;
    else process.env.TEST_GOOGLE_TOKEN = previous;
  }
});

test("preserves per-service health evidence for partial failures", async () => {
  const previous = process.env.GOOGLE_MCP_ACCESS_TOKEN;
  process.env.GOOGLE_MCP_ACCESS_TOKEN = "fake-token";
  try {
    const result = await googleMcpStatus(localConfig, {}, {
      probeLocal: async () => ({
        ok: false,
        health: {
          ok: false,
          processReady: true,
          checkedAt: "2026-09-22T12:00:00.000Z",
          services: {
            gmail: {state: "verified", code: "ok"},
            drive: {state: "forbidden", code: "google_forbidden", status: 403},
          },
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.processReady, true);
    assert.equal(result.servers.find((server) => server.serviceKey === "gmail").state, "verified");
    assert.deepEqual(result.servers.find((server) => server.serviceKey === "drive").verification, {
      state: "forbidden", code: "google_forbidden", status: 403,
    });
    assert.equal(result.checkedAt, "2026-09-22T12:00:00.000Z");
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_MCP_ACCESS_TOKEN;
    else process.env.GOOGLE_MCP_ACCESS_TOKEN = previous;
  }
});

test("reports empty status without Google configuration", async () => {
  assert.deepEqual(await googleMcpStatus({harnessId: "pi", mcpConfigRaw: "{}"}), {ok: true, supported: true, servers: []});
});

test("health probe keeps runner credentials out of its MCP child", async () => {
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stdin = {
    write(payload) {
      const message = JSON.parse(payload);
      const response = message.id === 1 ? {
        jsonrpc: "2.0", id: 1, result: {protocolVersion: "2025-06-18"},
      } : message.id === 2 ? {
        jsonrpc: "2.0", id: 2, result: {tools: [{name: "google_workspace_health"}]},
      } : {
        jsonrpc: "2.0", id: 3, result: {
          structuredContent: {
            ok: true,
            processReady: true,
            checkedAt: "2026-09-22T12:00:00.000Z",
            services: {gmail: {state: "verified", code: "ok"}},
          },
        },
      };
      setImmediate(() => stdout.emit("data", `${JSON.stringify(response)}\n`));
      return true;
    },
  };
  child.kill = () => {};
  let spawnOptions;
  const result = await probeLocalMcp({command: "node", args: ["/app/google-workspace-mcp/server.mjs"]}, {
    config: {googleMcpTokenSocketPath: "/private/google-token.sock"},
    spawnImpl: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(spawnOptions.env.GOOGLE_MCP_TOKEN_SOCKET, "/private/google-token.sock");
  assert.equal(spawnOptions.env.SESSION_SHUTDOWN_TOKEN, undefined);
  assert.equal(spawnOptions.env.GOOGLE_MCP_TOKEN_REFRESH_URL, undefined);
  assert.equal(spawnOptions.env.GOOGLE_MCP_CONNECTION_ID, undefined);
});
