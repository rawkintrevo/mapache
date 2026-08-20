"use strict";

const assert = require("assert");
const {
  ACCESS_TOKEN_ENV,
  ENABLED_SERVICES_ENV,
  EXECUTION_MODE_ENV,
  GRANTED_SCOPES_ENV,
  LOCAL_MCP_ARGS,
  LOCAL_MCP_COMMAND,
  createGoogleWorkspaceProvisioningService,
} = require("./googleWorkspaceProvisioning.service");

const calls = [];
const connections = {
  async getGoogleWorkspaceBinding(uid, workspaceId) {
    calls.push(["binding", uid, workspaceId]);
    return workspaceId === "workspace-empty" ? null : {connectionId: "connection-a", enabledServices: ["gmail", "drive"]};
  },
  async getGoogleConnection(uid, connectionId) {
    calls.push(["connection", uid, connectionId]);
    return {metadata: {
      connectionId,
      email: "a@example.com",
      displayName: "Account A",
      grantedScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
      status: "connected",
    }};
  },
};
const oauth = {
  async refreshGoogleConnection(uid, connectionId) {
    calls.push(["refresh", uid, connectionId]);
    return {accessToken: "fake-access-token"};
  },
};

(async () => {
  const service = createGoogleWorkspaceProvisioningService({connectionsService: connections, executionMode: "hosted", oauthService: oauth});
  const runtime = await service.resolveGoogleMcpRuntime("user-a", "workspace-a", {
    mcpServers: {custom: {command: "node"}},
  });
  assert.deepStrictEqual(Object.keys(runtime.mcpConfig.mcpServers), ["custom", "google-gmail", "google-drive"]);
  assert.strictEqual(runtime.mcpConfig.mcpServers["google-gmail"].authMode, "bearer_env");
  assert.strictEqual(runtime.mcpConfig.mcpServers["google-gmail"].bearerTokenEnv, ACCESS_TOKEN_ENV);
  assert.strictEqual(runtime.mcpConfig.mcpServers["google-gmail"].protocolVersion, "auto");
  assert.deepStrictEqual(runtime.env, {
    [ACCESS_TOKEN_ENV]: "fake-access-token",
    [EXECUTION_MODE_ENV]: "hosted",
    GOOGLE_MCP_CONNECTION_STATUS: "connected",
    GOOGLE_MCP_ACCOUNT_EMAIL: "a@example.com",
    GOOGLE_MCP_ACCOUNT_NAME: "Account A",
    [ENABLED_SERVICES_ENV]: "[\"gmail\",\"drive\"]",
    [GRANTED_SCOPES_ENV]: "[\"https://www.googleapis.com/auth/gmail.readonly\",\"https://www.googleapis.com/auth/drive.readonly\"]",
  });
  assert.deepStrictEqual(await service.resolveGoogleMcpRuntime("user-a", "workspace-empty", {mcpServers: {custom: {command: "node"}}}), {
    mcpConfig: {version: 1, mcpServers: {custom: {command: "node", args: []}}},
    env: {},
  });
  assert.deepStrictEqual(calls, [
    ["binding", "user-a", "workspace-a"],
    ["connection", "user-a", "connection-a"],
    ["refresh", "user-a", "connection-a"],
    ["binding", "user-a", "workspace-empty"],
  ]);

  const local = createGoogleWorkspaceProvisioningService({connectionsService: connections, executionMode: "local", oauthService: oauth});
  const localRuntime = await local.resolveGoogleMcpRuntime("user-a", "workspace-a", {mcpServers: {custom: {command: "node"}}});
  assert.deepStrictEqual(localRuntime.mcpConfig.mcpServers["google-workspace"], {
    command: LOCAL_MCP_COMMAND,
    args: LOCAL_MCP_ARGS,
  });
  assert.equal(localRuntime.mcpConfig.mcpServers["google-gmail"], undefined);
  assert.equal(localRuntime.env[ACCESS_TOKEN_ENV], "fake-access-token");
  assert.equal(localRuntime.env[ENABLED_SERVICES_ENV], "[\"gmail\",\"drive\"]");
  assert.equal(localRuntime.env[GRANTED_SCOPES_ENV].includes("fake-access-token"), false);
  console.log("google workspace provisioning service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
