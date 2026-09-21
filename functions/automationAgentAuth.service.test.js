"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAutomationAgentAuthService,
  TOKEN_TTL_SECONDS,
} = require("./automationAgentAuth.service");

class Ref {
  constructor(value) {
    this.value = value;
  }

  async get() {
    return {exists: this.value !== undefined, data: () => this.value};
  }
}

class Db {
  constructor(data) {
    this.data = data;
  }

  collection(name) {
    return {doc: (id) => new Ref(this.data.get(`${name}/${id}`))};
  }
}

function createHarness() {
  const data = new Map([
    ["workspaces/workspace-1", {ownerUid: "user-1"}],
    ["workspaces/workspace-2", {ownerUid: "user-1"}],
    ["workspaces/workspace-1/sessions/session-1", {
      ownerUid: "user-1",
      workspaceId: "workspace-1",
      shutdownToken: "runner-secret",
      runtimeKind: "automation",
      status: "running",
      agentRuntimeAuthorityState: "admitted",
      agentRuntimeSessionId: "session-1",
      agentRuntimeGeneration: 7,
      agentRuntimeBootInstanceId: "boot-1",
    }],
  ]);
  const db = new Db(data);
  const service = createAutomationAgentAuthService({
    db,
    now: () => Date.parse("2026-09-20T12:00:00Z"),
    secret: "test-signing-secret",
    sessionCollection: (workspaceId) => ({
      doc: (sessionId) => new Ref(data.get(`workspaces/${workspaceId}/sessions/${sessionId}`)),
    }),
  });
  return {data, service};
}

function request(body, token = "runner-secret") {
  return {body, method: "POST", get: (name) => name === "x-shutdown-token" ? token : ""};
}

test("mints a short-lived scoped token and rejects forged audience or expiry", async () => {
  const {data, service} = createHarness();
  const minted = await service.mintToken(request({workspaceId: "workspace-1", sessionId: "session-1"}));
  assert.equal(minted.expiresIn, TOKEN_TTL_SECONDS);
  const claims = service.verifyToken(minted.accessToken);
  assert.deepEqual({
    ownerUid: claims.ownerUid,
    workspaceId: claims.workspaceId,
    sessionId: claims.sessionId,
    generation: claims.generation,
    bootInstanceId: claims.bootInstanceId,
  }, {
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    generation: "7",
    bootInstanceId: "boot-1",
  });

  const parts = minted.accessToken.split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  payload.aud = "other-api";
  const forged = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[2]}`;
  assert.throws(() => service.verifyToken(forged), (error) => error.status === 401 && error.publicMessage === "automation_agent_unauthorized");

});

test("does not enumerate sibling workspaces or accept the runner secret as an API token", async () => {
  const {service} = createHarness();
  await assert.rejects(
      () => service.mintToken(request({workspaceId: "workspace-2", sessionId: "session-1"})),
      (error) => error.status === 401 && error.publicMessage === "automation_agent_unauthorized",
  );
  assert.throws(
      () => service.verifyToken("runner-secret"),
      (error) => error.status === 401 && error.publicMessage === "automation_agent_unauthorized",
  );
});
