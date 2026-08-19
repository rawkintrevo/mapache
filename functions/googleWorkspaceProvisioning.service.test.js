"use strict";

const assert = require("assert");
const {
  ACCESS_TOKEN_ENV,
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
    return {connectionId, email: "a@example.com", displayName: "Account A", status: "connected"};
  },
};
const oauth = {
  async refreshGoogleConnection(uid, connectionId) {
    calls.push(["refresh", uid, connectionId]);
    return {accessToken: "fake-access-token"};
  },
};

(async () => {
  const service = createGoogleWorkspaceProvisioningService({connectionsService: connections, oauthService: oauth});
  const runtime = await service.resolveGoogleMcpRuntime("user-a", "workspace-a", {
    mcpServers: {custom: {command: "node"}},
  });
  assert.deepStrictEqual(Object.keys(runtime.mcpConfig.mcpServers), ["custom", "google-gmail", "google-drive"]);
  assert.strictEqual(runtime.mcpConfig.mcpServers["google-gmail"].authMode, "bearer_env");
  assert.strictEqual(runtime.mcpConfig.mcpServers["google-gmail"].bearerTokenEnv, ACCESS_TOKEN_ENV);
  assert.deepStrictEqual(runtime.env, {[ACCESS_TOKEN_ENV]: "fake-access-token"});
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
  console.log("google workspace provisioning service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
