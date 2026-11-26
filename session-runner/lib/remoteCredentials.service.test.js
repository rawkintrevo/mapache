"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRemoteCredentialsService} = require("./remoteCredentials.service");

const NOW = Date.parse("2026-11-26T00:00:00.000Z");

test("materializes owner-scoped credentials and MCP config without a Firebase service account", async () => {
  const calls = [];
  const originalApiUrl = process.env.REMOTE_TEST_API_URL;
  const config = {
    agentRuntimeBootInstanceId: "boot-1",
    agentRuntimeGeneration: "4",
    googleMcpAccountEmail: "",
    googleMcpAccountName: "",
    googleMcpConnectionId: "",
    googleMcpConnectionStatus: "",
    googleMcpEnabledServices: "",
    googleMcpTokenRefreshUrl: "",
    mcpConfigRaw: "{}",
    ownerUid: "owner-1",
    remoteCredentialBrokerUrl: "https://functions.example/remoteVmCredentials_v2",
    sessionBrowserTokenSecret: "browser-secret",
    sessionId: "session-1",
    workspaceId: "workspace-1",
  };
  const service = createRemoteCredentialsService(config, {
    now: () => NOW,
    fetch: async (url, options) => {
      calls.push({url, options});
      return Response.json({
        ok: true,
        expiresAt: new Date(NOW + 240_000).toISOString(),
        generation: 4,
        auth: {providers: {openai: {type: "api_key", key: "secret"}}, entries: {}},
        environment: {
          REMOTE_TEST_API_URL: "https://api.example.test",
          GOOGLE_MCP_ACCESS_TOKEN: "google-access-token",
          GOOGLE_MCP_CONNECTION_ID: "google-connection",
          GOOGLE_MCP_CONNECTION_STATUS: "connected",
        },
        mcpConfig: {mcpServers: {google: {command: "node", args: ["/app/google-workspace-mcp/server.mjs"]}}},
      });
    },
  });
  try {
    const result = await service.materialize();
    assert.equal(result.auth.providers.openai.key, "secret");
    assert.equal(process.env.REMOTE_TEST_API_URL, "https://api.example.test");
    assert.equal(config.googleMcpConnectionId, "google-connection");
    assert.deepEqual(JSON.parse(config.mcpConfigRaw), result.mcpConfig);
    assert.equal(calls.length, 1);
    assert.match(calls[0].options.headers.authorization, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), {});
  } finally {
    if (originalApiUrl === undefined) delete process.env.REMOTE_TEST_API_URL;
    else process.env.REMOTE_TEST_API_URL = originalApiUrl;
  }
});

test("remote credential materialization rejects reserved environment injection", async () => {
  const config = {
    agentRuntimeGeneration: "1", ownerUid: "owner-1", sessionBrowserTokenSecret: "secret",
    sessionId: "session-1", workspaceId: "workspace-1",
    remoteCredentialBrokerUrl: "https://functions.example/remoteVmCredentials_v2",
  };
  const service = createRemoteCredentialsService(config, {
    now: () => NOW,
    fetch: async () => Response.json({
      ok: true, expiresAt: new Date(NOW + 240_000).toISOString(), generation: 1,
      auth: {providers: {}, entries: {}}, environment: {SESSION_SHUTDOWN_TOKEN: "forged"},
      mcpConfig: {mcpServers: {}},
    }),
  });
  await assert.rejects(() => service.materialize(), (error) => error.code === "remote_credentials_invalid_response");
});

