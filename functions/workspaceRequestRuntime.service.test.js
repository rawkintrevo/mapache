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

test("retains a claimed dispatch after an ambiguous runner failure for later reconciliation", async () => {
  const {calls, db, service} = setup({runner: async () => { throw new Error("runner timeout"); }});
  const first = await service.provision("run-1");
  assert.equal(first.pending, true);
  assert.equal(calls.length, 2); // submit, then the status check; never a replay
  assert.equal(db.values.get("automationRuns/run-1").status, "provisioning");
});

test("overlapping provisioning reconciles the existing claim and submits exactly once", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let status = "not_found";
  const {calls, db, service} = setup({runner: async (_session, route, options = {}) => {
    if (route === "/workspace/requests" && options.method === "POST") {
      await held;
      return {ok: true, conversationId: "conversation-1", status: "running"};
    }
    if (route === "/workspace/requests/run-1" && status === "not_found") {
      return {ok: false, error: "workspace_request_not_found"};
    }
    return {ok: true, request: {
      runId: "run-1", status: "succeeded", conversationId: "conversation-1",
      state: {finalResult: "success", finalAnswer: "The answer arrived once."},
    }};
  }});

  const first = service.provision("run-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.route === "/workspace/requests").length, 1);

  const second = await service.provision("run-1");
  assert.equal(second.pending, true);
  assert.equal(db.values.get("automationRuns/run-1").status, "provisioning");

  status = "succeeded";
  release();
  const firstResult = await first;
  assert.equal(firstResult.dispatched, true);
  const completed = await service.reconcile("run-1");
  assert.deepEqual(completed, {completed: true, runId: "run-1", status: "succeeded"});
  assert.equal(calls.filter((call) => call.route === "/workspace/requests" && call.options.method === "POST").length, 1);
  assert.equal(db.values.get("automationRuns/run-1").finalAnswer, "The answer arrived once.");
});

test("duplicate provisioning after acknowledgment reads status without another submission", async () => {
  const {calls, service} = setup({runner: (_session, route, options = {}) => route === "/workspace/requests" && options.method !== "POST" ?
    {ok: true, request: {runId: "run-1", status: "running", conversationId: "conversation-1"}} : undefined});
  await service.provision("run-1");
  const repeated = await service.provision("run-1");
  assert.equal(repeated.running, true);
  assert.equal(calls.filter((call) => call.route === "/workspace/requests" && call.options.method === "POST").length, 1);
  assert.equal(calls.filter((call) => call.route === "/workspace/requests/run-1").length, 1);
});

test("transient status lookup failure retains an acknowledged request", async () => {
  let attempts = 0;
  const {db, service} = setup({runner: (_session, route, options = {}) => {
    if (route === "/workspace/requests" && options.method === "POST") return {ok: true, conversationId: "conversation-1", status: "running"};
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("temporary status timeout"), {status: 503});
    return {ok: true, request: {runId: "run-1", status: "succeeded", conversationId: "conversation-1", state: {finalResult: "success", finalAnswer: "done"}}};
  }});
  await service.provision("run-1");
  const retained = await service.reconcile("run-1");
  assert.equal(retained.pending, true);
  assert.equal(db.values.get("automationRuns/run-1").status, "running");
  const completed = await service.reconcile("run-1");
  assert.equal(completed.completed, true);
  assert.equal(db.values.get("automationRuns/run-1").finalAnswer, "done");
});

test("stale generation claims become ambiguous without resubmitting the prompt", async () => {
  const {calls, db, service} = setup({runner: (_session, route) => route === "/workspace/requests/run-1" ?
    {ok: false, error: "workspace_request_not_found"} : assert.fail(`unexpected runner route ${route}`)});
  db.values.set("automationRuns/run-1", {
    ...db.values.get("automationRuns/run-1"),
    dispatchClaim: {id: "old-claim", sessionId: "old-session", generation: 3, state: "claimed", claimedAt: "2026-09-20T09:00:00.000Z"},
    sessionId: "old-session",
    sharedRuntimeGeneration: 3,
  });
  const result = await service.provision("run-1");
  assert.equal(result.interrupted, true);
  assert.equal(db.values.get("automationRuns/run-1").executionErrorCode, "shared_runtime_dispatch_ambiguous");
  assert.equal(calls.some((call) => call.route === "/workspace/requests" && call.options.method === "POST"), false);
});

test("committed cancellation wins over a late successful runner outcome", async () => {
  const {db, service} = setup({runner: (_session, route, options = {}) => route === "/workspace/requests" && options.method === "POST" ?
    {ok: true, conversationId: "conversation-1", status: "running"} :
    {ok: true, request: {runId: "run-1", status: "succeeded", conversationId: "conversation-1", state: {finalResult: "success", finalAnswer: "too late"}}}});
  await service.provision("run-1");
  db.values.set("automationRuns/run-1", {...db.values.get("automationRuns/run-1"), status: "stopping", desiredOutcome: "canceled", cancellationRequestedAt: "now"});
  const result = await service.reconcile("run-1");
  assert.equal(result.status, "canceled");
  assert.equal(db.values.get("automationRuns/run-1").status, "canceled");
  assert.equal(db.values.get("automationRuns/run-1").finalAnswer, undefined);
});

test("repairs an interrupted ticket only with matching runner and ticket evidence", async () => {
  const {db, service} = setup({runner: (_session, route) => route === "/workspace/requests/run-1" ?
    {ok: true, request: {runId: "run-1", status: "succeeded", conversationId: "conversation-1", state: {finalResult: "success", finalAnswer: "recovered"}}} :
    {ok: true, conversationId: "conversation-1", status: "running"}});
  db.values.set("automationRuns/run-1", {
    ...db.values.get("automationRuns/run-1"),
    status: "interrupted",
    cleanupState: "complete",
    sessionId: "main",
    sharedRuntimeGeneration: 4,
    conversationId: "conversation-1",
    dispatchClaim: {id: "claim-1", sessionId: "main", generation: 4, state: "claimed"},
    executionErrorCode: "shared_runtime_dispatch_ambiguous",
    lastError: "shared_runtime_dispatch_ambiguous",
    sinkDelivery: {"ticket_result:0": {state: "delivered", attempts: 1, lastError: null}},
  });
  db.values.set("workspaceTickets/ticket-1", {runId: "run-1", status: "interrupted"});
  const result = await service.reconcile("run-1");
  assert.deepEqual(result, {repaired: true, runId: "run-1", status: "succeeded"});
  const repaired = db.values.get("automationRuns/run-1");
  assert.equal(repaired.status, "succeeded");
  assert.equal(repaired.cleanupState, "pending");
  assert.equal(repaired.sinkDelivery["ticket_result:0"].state, "pending");
  assert.equal(repaired.dispatchRepair.fromErrorCode, "shared_runtime_dispatch_ambiguous");
});

test("does not repair a canceled ticket or a ticket that points to a newer run", async () => {
  const {db, service} = setup({runner: (_session, route) => route === "/workspace/requests/run-1" ?
    {ok: true, request: {runId: "run-1", status: "succeeded", conversationId: "conversation-1", state: {finalResult: "success", finalAnswer: "must not publish"}}} :
    {ok: true, conversationId: "conversation-1", status: "running"}});
  db.values.set("automationRuns/run-1", {
    ...db.values.get("automationRuns/run-1"),
    status: "interrupted", cleanupState: "complete", sessionId: "main", sharedRuntimeGeneration: 4,
    conversationId: "conversation-1",
    dispatchClaim: {id: "claim-1", sessionId: "main", generation: 4, state: "claimed"},
    executionErrorCode: "shared_runtime_dispatch_ambiguous",
  });
  db.values.set("workspaceTickets/ticket-1", {runId: "run-2", status: "running"});
  const result = await service.reconcile("run-1");
  assert.equal(result.repaired, undefined);
  assert.equal(db.values.get("automationRuns/run-1").status, "interrupted");

  db.values.set("workspaceTickets/ticket-1", {runId: "run-1", status: "canceled"});
  const canceled = await service.reconcile("run-1");
  assert.equal(canceled.repaired, undefined);
  assert.equal(db.values.get("automationRuns/run-1").status, "interrupted");
});

test("classifies nested provider/model failures with safe corrective fields", async () => {
  const {db, service} = setup({
    runner: (_session, route) => route === "/workspace/requests" ?
      {ok: true, conversationId: "conversation-1", status: "running"} :
      {ok: true, request: {
        status: "failed",
        state: {finalError: "Codex error: The gpt-5.5 model is not supported for this account."},
      }},
  });
  await service.provision("run-1");
  await service.reconcile("run-1");
  const run = db.values.get("automationRuns/run-1");
  assert.equal(run.executionErrorCode, "workspace_request_model_auth_incompatible");
  assert.match(run.executionErrorMessage, /model is not supported/);
  assert.match(run.executionErrorAction, /available model/);
  assert.equal(run.status, "failed");
});

console.log("workspace request runtime service tests passed");
