"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SHARED_RUNTIME_EXECUTION_ROUTE,
  createWorkspaceRequestRuntimeService,
} = require("./workspaceRequestRuntime.service");

class Ref {
  constructor(db, path, id) { this.db = db; this.path = path; this.id = id; }
  async get() { const value = this.db.values.get(this.path); return {id: this.id, exists: value !== undefined, data: () => value}; }
  async update(value) { this.db.values.set(this.path, {...(this.db.values.get(this.path) || {}), ...value}); }
  async set(value) { this.db.values.set(this.path, value); }
}

class Collection {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return new Ref(this.db, `${this.path}/${id}`, id); }
  async get() {
    const prefix = `${this.path}/`;
    const docs = [...this.db.values.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map(([path, value]) => ({id: path.slice(prefix.length), data: () => value}));
    return {docs};
  }
}

class Db {
  constructor() { this.values = new Map(); }
  collection(name) { return new Collection(this, name); }
  async runTransaction(callback) {
    return callback({
      get: (ref) => ref.get(),
      set: (ref, value) => ref.set(value),
      update: (ref, value) => ref.update(value),
    });
  }
}

const admin = {firestore: {FieldValue: {serverTimestamp: () => "now"}}};

function setup(overrides = {}) {
  const db = new Db();
  db.values.set("workspaces/target", {ownerUid: "owner", name: "Target", canonicalSessionId: "main"});
  db.values.set("workspaces/target/sessions/main", {
    ownerUid: "owner", workspaceId: "target", runtimeKind: "main", status: "running",
    serviceUrl: "https://runner.example", shutdownToken: "shutdown", agentRuntimeGeneration: 4,
  });
  db.values.set("automationRuns/run-1", {
    runId: "run-1", ownerUid: "owner", workspaceId: "target", status: "provisioning",
    executionRoute: SHARED_RUNTIME_EXECUTION_ROUTE, ticketId: "ticket-1",
    snapshot: {prompt: "Inspect the target workspace", modelSelection: {providerId: "openai", modelId: "gpt-5"}},
    workspaceRunRequest: {source: {id: "source"}, instructions: "Inspect the target workspace"},
  });
  const calls = [];
  const service = createWorkspaceRequestRuntimeService({
    admin,
    createSession: async () => { throw new Error("not expected"); },
    db,
    requestRunnerJson: async (session, route, options) => {
      calls.push({session, route, options});
      return overrides.runner?.(session, route, options) || {ok: true, conversationId: "conversation-1", status: "running"};
    },
    requireWorkspace: async () => ({id: "target", name: "Target", canonicalSessionId: "main"}),
    restartSession: async () => { throw new Error("not expected"); },
    sessionCollection: (workspaceId) => db.collection(`workspaces/${workspaceId}/sessions`),
  });
  return {calls, db, service};
}

test("dispatches an incoming request into the existing normal runtime exactly once", async () => {
  const {calls, db, service} = setup();
  const result = await service.provision("run-1");
  assert.deepEqual(result, {dispatched: true, runId: "run-1", sessionId: "main", conversationId: "conversation-1"});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, "/workspace/requests");
  assert.equal(calls[0].options.timeoutMs, 300_000);
  assert.equal(calls[0].options.body.runId, "run-1");
  assert.equal(calls[0].options.body.modelRef, "openai/gpt-5");
  assert.equal(db.values.get("automationRuns/run-1").status, "running");
  assert.equal(db.values.get("automationRuns/run-1").sessionId, "main");
});

test("reconciles the visible chat result and preserves a terminal ticket outcome", async () => {
  const {db, service} = setup({
    runner: (_session, route) => route === "/workspace/requests" ?
      {ok: true, conversationId: "conversation-1", status: "running"} :
      {ok: true, request: {status: "succeeded", conversationId: "conversation-1", state: {finalResult: "success", finalAnswer: "done"}}},
  });
  await service.provision("run-1");
  const result = await service.reconcile("run-1");
  assert.deepEqual(result, {completed: true, runId: "run-1", status: "succeeded"});
  assert.equal(db.values.get("automationRuns/run-1").status, "succeeded");
  assert.equal(db.values.get("automationRuns/run-1").finalAnswer, "done");
});

test("does not replay a claimed dispatch after an ambiguous runner failure", async () => {
  const {calls, db, service} = setup({runner: async () => { throw new Error("runner timeout"); }});
  const first = await service.provision("run-1");
  assert.equal(first.interrupted, true);
  assert.equal(calls.length, 1);
  assert.equal(db.values.get("automationRuns/run-1").status, "interrupted");
});

console.log("workspace request runtime service tests passed");
