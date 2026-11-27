"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRuntimeDescriptor, REMOTE_LIBVIRT_BACKEND} = require("./runtimeProvider.helpers");
const {
  TOKEN_AUDIENCE,
  createRemoteVmCredentialsService,
  signToken,
} = require("./remoteVmCredentials.service");

const NOW = Date.parse("2026-11-26T00:00:00.000Z");

class Ref {
  constructor(data, id, path) {
    this.value = data;
    this.id = id;
    this.path = path;
  }

  collection(name) {
    return new Collection(`${this.path}/${name}`);
  }

  async get() {
    return {exists: this.value !== undefined, id: this.id, data: () => this.value};
  }
}

class Collection {
  constructor(path) {
    this.path = path;
  }

  doc(id) {
    return new Ref(fixtures.get(`${this.path}/${id}`), id, `${this.path}/${id}`);
  }
}

const fixtures = new Map();
const descriptor = {
  ...createRuntimeDescriptor({
    backend: REMOTE_LIBVIRT_BACKEND,
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    generation: 4,
    guestResources: {vcpus: 3, memoryMiB: 4096, diskGiB: 40},
    hostId: "host-1",
    guestIp: "192.168.250.12",
  }),
  state: "running",
};

function request(token, body = {}) {
  return {method: "POST", headers: {authorization: `Bearer ${token}`}, body};
}

function setup() {
  fixtures.clear();
  fixtures.set("workspaces/workspace-1", {ownerUid: "owner-1", runtimeProvider: descriptor});
  fixtures.set("workspaces/workspace-1/sessions/session-1", {
    ownerUid: "owner-1",
    workspaceId: "workspace-1",
    status: "running",
    runnerSessionId: "session-1",
    browserAccessTokenSecret: "browser-secret",
    agentRuntimeGeneration: 4,
    agentRuntimeBootInstanceId: "boot-1",
    runtimeProvider: descriptor,
    authSelection: {harness: "pi", providers: {openai: "openai-entry", "github-cli": "github-entry"}},
    environmentEntryIds: ["env-1"],
    mcpConfig: {mcpServers: {custom: {url: "https://mcp.example.test"}}},
  });
  const db = {collection: (name) => new Collection(name)};
  const service = createRemoteVmCredentialsService({
    agentAuthService: {
      getPiAuth: async () => ({
        providers: {openai: {type: "api_key", key: "openai-secret"}, ignored: {type: "api_key", key: "other-secret"}},
        entries: {
          "openai-entry": {id: "openai-entry", providerKey: "openai", credential: {type: "api_key", key: "openai-secret"}},
          "github-entry": {id: "github-entry", providerKey: "github-cli", credential: {type: "api_key", key: "github-secret"}},
          "ignored-entry": {id: "ignored-entry", providerKey: "ignored", credential: {type: "api_key", key: "other-secret"}},
        },
      }),
    },
    db,
    environmentKeysService: {resolveGenericEnvironment: async () => ({API_URL: "https://api.example.test"})},
    googleWorkspaceProvisioningService: {
      resolveGoogleMcpRuntime: async () => ({
        env: {GOOGLE_MCP_ACCESS_TOKEN: "short-lived-google-token"},
        mcpConfig: {mcpServers: {"google-workspace": {command: "node", args: ["/app/google-workspace-mcp/server.mjs"]}}},
      }),
    },
    now: () => NOW,
  });
  const token = signToken({
    bootId: "boot-1",
    expiresAt: NOW + 60_000,
    generation: 4,
    issuedAt: () => NOW,
    ownerUid: "owner-1",
    secret: "browser-secret",
    sessionId: "session-1",
    workspaceId: "workspace-1",
  });
  return {service, token};
}

test("remote credential broker returns only selected owner material and refreshable Google config", async () => {
  const {service, token} = setup();
  const result = await service.resolve(request(token));
  assert.equal(result.ok, true);
  assert.equal(result.generation, 4);
  assert.deepEqual(Object.keys(result.auth.entries), ["openai-entry", "github-entry"]);
  assert.deepEqual(Object.keys(result.auth.providers).sort(), ["github-cli", "openai"]);
  assert.equal(result.auth.providers.openai.key, "openai-secret");
  assert.deepEqual(result.environment, {
    API_URL: "https://api.example.test",
    GOOGLE_MCP_ACCESS_TOKEN: "short-lived-google-token",
  });
  assert.equal(result.mcpConfig.mcpServers["google-workspace"].command, "node");
  assert.equal(JSON.stringify(result).includes("other-secret"), false);
  assert.equal(TOKEN_AUDIENCE, "remote-credentials");
});

test("remote credential broker denies forged, stale, and other-owner tokens", async () => {
  const {service, token} = setup();
  await assert.rejects(() => service.resolve(request(token.slice(0, -1) + "x")), (error) => error.status === 404);
  const stale = signToken({
    expiresAt: NOW + 60_000, generation: 3, issuedAt: () => NOW, ownerUid: "owner-1",
    secret: "browser-secret", sessionId: "session-1", workspaceId: "workspace-1",
  });
  await assert.rejects(() => service.resolve(request(stale)), (error) => error.status === 404);
  const foreign = signToken({
    expiresAt: NOW + 60_000, generation: 4, issuedAt: () => NOW, ownerUid: "owner-2",
    secret: "browser-secret", sessionId: "session-1", workspaceId: "workspace-1",
  });
  await assert.rejects(() => service.resolve(request(foreign)), (error) => error.status === 404);
});

