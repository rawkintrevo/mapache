"use strict";

const assert = require("node:assert/strict");
const {createGoogleWorkspaceProvisioningService} = require("./googleWorkspaceProvisioning.service");

const records = new Map([
  ["user-a:workspace-a", {connectionId: "connection-a", enabledServices: ["gmail", "drive"]}],
  ["user-b:workspace-b", {connectionId: "connection-b", enabledServices: ["calendar", "docs"]}],
]);
const connections = {
  async getGoogleWorkspaceBinding(uid, workspaceId) {
    return records.get(`${uid}:${workspaceId}`) || null;
  },
  async getGoogleConnection(uid, connectionId) {
    return {metadata: {
      connectionId,
      email: `${uid}@example.com`,
      displayName: uid,
      status: "connected",
      grantedScopes: connectionId === "connection-a" ? [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
      ] : [
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events.freebusy",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/documents.readonly",
      ],
    }};
  },
};
const oauth = {
  async refreshGoogleConnection(_uid, connectionId) {
    return {accessToken: connectionId === "connection-a" ? "token-a-secret" : "token-b-secret"};
  },
};

(async () => {
  const service = createGoogleWorkspaceProvisioningService({connectionsService: connections, executionMode: "local", oauthService: oauth});
  const [runtimeA, runtimeB] = await Promise.all([
    service.resolveGoogleMcpRuntime("user-a", "workspace-a", {mcpServers: {}}),
    service.resolveGoogleMcpRuntime("user-b", "workspace-b", {mcpServers: {}}),
  ]);
  assert.equal(runtimeA.env.GOOGLE_MCP_ACCESS_TOKEN, "token-a-secret");
  assert.equal(runtimeB.env.GOOGLE_MCP_ACCESS_TOKEN, "token-b-secret");
  assert.deepEqual(JSON.parse(runtimeA.env.GOOGLE_MCP_ENABLED_SERVICES).sort(), ["drive", "gmail"]);
  assert.deepEqual(JSON.parse(runtimeB.env.GOOGLE_MCP_ENABLED_SERVICES).sort(), ["calendar", "docs"]);
  assert.doesNotMatch(JSON.stringify(runtimeA.mcpConfig), /token-a-secret|token-b-secret/);
  assert.doesNotMatch(JSON.stringify(runtimeB.mcpConfig), /token-a-secret|token-b-secret/);
  assert.doesNotMatch(runtimeA.env.GOOGLE_MCP_GRANTED_SCOPES, /token/);
  assert.doesNotMatch(runtimeB.env.GOOGLE_MCP_GRANTED_SCOPES, /token/);
  console.log("google workspace isolation tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
