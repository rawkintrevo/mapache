"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createVmWorkspaceRuntimeService, VM_COLLECTION} = require("./vmWorkspaceRuntime.service");

class Ref {
  constructor(db, path, id) { this.db = db; this.path = path; this.id = id; }
  async get() {
    const value = this.db.values.get(this.path);
    return {exists: value !== undefined, id: this.id, data: () => value};
  }
  collection(name) { return new Collection(this.db, `${this.path}/${name}`); }
}

class Collection {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return new Ref(this.db, `${this.path}/${id}`, id); }
}

class Db {
  constructor() { this.values = new Map(); }
  collection(name) { return new Collection(this, name); }
}

function setup({state = "active"} = {}) {
  const db = new Db();
  const now = 1_000_000;
  db.values.set(`${VM_COLLECTION}/workspace-1`, {
    ownerUid: "owner-1",
    backend: "compute-engine",
    apiEnabled: true,
    lifecycleEnabled: true,
    state,
    generation: 4,
    currentSessionId: "vm-session-4",
    gatewayHost: "vm-1.example.com",
    bootId: state === "active" ? "boot-4" : null,
    lifecycleReadyGeneration: state === "active" ? 4 : null,
    activeOperationId: null,
    leaseExpiresAt: state === "active" ? now + 60_000 : 0,
  });
  db.values.set(`${VM_COLLECTION}/workspace-1/sessions/vm-session-4`, {
    ownerUid: "owner-1",
    generation: 4,
    state: state === "active" ? "active" : "reserved",
    bootId: state === "active" ? "boot-4" : null,
    leaseExpiresAt: state === "active" ? now + 60_000 : 0,
  });
  db.values.set("vmRuntimeCredentials_v2/vm-session-4", {
    ownerUid: "owner-1",
    generation: 4,
    browserToken: "browser-secret",
    shutdownToken: "shutdown-secret",
  });
  const calls = [];
  const service = createVmWorkspaceRuntimeService({
    db,
    lifecycle: {
      request: async (request) => {
        calls.push(request);
        const runtime = db.values.get(`${VM_COLLECTION}/workspace-1`);
        db.values.set(`${VM_COLLECTION}/workspace-1`, {...runtime, state: "active", bootId: "boot-4", lifecycleReadyGeneration: 4, leaseExpiresAt: now + 60_000});
        const session = db.values.get(`${VM_COLLECTION}/workspace-1/sessions/vm-session-4`);
        db.values.set(`${VM_COLLECTION}/workspace-1/sessions/vm-session-4`, {...session, state: "active", bootId: "boot-4", leaseExpiresAt: now + 60_000});
        return {operationId: "operation-1", status: "pending"};
      },
    },
    now: () => now,
    delay: async () => {},
    startupTimeoutMs: 100,
    pollIntervalMs: 1,
  });
  return {calls, db, service};
}

test("wakes a stopped VM through the durable lifecycle and returns a fresh agent token", async () => {
  const {calls, service} = setup({state: "stopped"});
  const session = await service.ensureReady("owner-1", "workspace-1", {requestId: "run-1"});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    requestId: "run-1",
    action: "start",
    expectedGeneration: 4,
    requireApiAdmission: true,
  });
  assert.equal(session.serviceUrl, "https://vm-1.example.com");
  assert.equal(session.shutdownToken, "shutdown-secret");
  assert.match(session.runnerAccessToken, /^[^.]+\.[^.]+$/);
  assert.equal(JSON.parse(Buffer.from(session.runnerAccessToken.split(".")[0], "base64url").toString()).aud, "agent");
});

test("reuses an already-ready VM without creating a second lifecycle operation", async () => {
  const {calls, service} = setup();
  const session = await service.ensureReady("owner-1", "workspace-1", {requestId: "run-1"});
  assert.equal(calls.length, 0);
  assert.equal(session.id, "vm-session-4");
  assert.equal(session.agentRuntimeGeneration, 4);
});

test("does not disclose or operate a VM owned by another user", async () => {
  const {service} = setup();
  await assert.rejects(() => service.ensureReady("owner-2", "workspace-1"), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.publicMessage, "workspace_not_found");
    return true;
  });
});

test("does not wake a VM that is not API-admitted", async () => {
  const {db, calls, service} = setup({state: "stopped"});
  const runtimePath = `${VM_COLLECTION}/workspace-1`;
  db.values.set(runtimePath, {...db.values.get(runtimePath), apiEnabled: false});
  await assert.rejects(() => service.ensureReady("owner-1", "workspace-1", {requestId: "run-1"}), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.publicMessage, "workspace_not_found");
    return true;
  });
  assert.equal(calls.length, 0);
});

console.log("vm workspace runtime service tests passed");
