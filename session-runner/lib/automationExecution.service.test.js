"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createAutomationExecutionService} = require("./automationExecution.service");

const admin = {firestore: {FieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"}}};

class Ref {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }

  async get() {
    const value = this.db.data.get(this.path);
    return {exists: value !== undefined, id: this.id, data: () => value, ref: this};
  }

  update(updates) {
    this.db.data.set(this.path, {...(this.db.data.get(this.path) || {}), ...updates});
  }

  collection(name) {
    return new Collection(this.db, `${this.path}/${name}`);
  }
}

class Collection {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id) {
    return new Ref(this.db, `${this.path}/${id}`, id);
  }
}

class Db {
  constructor() {
    this.data = new Map();
  }

  collection(name) {
    return new Collection(this, name);
  }

  async runTransaction(callback) {
    return callback({
      get: (ref) => ref.get(),
      update: (ref, updates) => ref.update(updates),
    });
  }
}

function authority() {
  return {
    isCurrentWriter: () => true,
    status: () => ({admitted: true, bootInstanceId: "boot-1", generation: 7}),
  };
}

function setup({run = {}, session = {}, workspace = {}, adapter} = {}) {
  const db = new Db();
  db.data.set("workspaces/workspace-1", {
    ownerUid: "user-1",
    ...workspace,
  });
  db.data.set("workspaces/workspace-1/sessions/auto-run-1", {
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    runnerSessionId: "auto-run-1",
    runtimeKind: "automation",
    automationRunId: "run-1",
    status: "running",
    agentRuntimeSessionId: "auto-run-1",
    agentRuntimeGeneration: 7,
    agentRuntimeBootInstanceId: "boot-1",
    agentRuntimeAuthorityState: "admitted",
    ...session,
  });
  db.data.set("automationRuns/run-1", {
    runId: "run-1",
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    sessionId: "auto-run-1",
    status: "running",
    cleanupState: "pending",
    snapshot: {prompt: "run the browser workflow", modelSelection: null},
    ...run,
  });
  const calls = [];
  const service = createAutomationExecutionService({
    admin,
    config: {
      agentRuntimeEnabled: true,
      automationRunId: "run-1",
      ownerUid: "user-1",
      runtimeKind: "automation",
      sessionId: "auto-run-1",
      workspaceId: "workspace-1",
    },
    db,
    piWebUi: adapter || {
      automationStatus: async () => ({ok: true, runId: "run-1", status: "running"}),
      startAutomation: async (input) => {
        calls.push(input);
        return {ok: true, runId: input.runId, conversationId: "conversation-1", status: "running"};
      },
    },
    setTimeoutImpl: () => ({unref: () => {}}),
    workspaceAuthority: authority(),
  });
  return {calls, db, service};
}

test("claims and submits once, then records a normalized terminal outcome", async () => {
  const {calls, db, service} = setup({
    adapter: {
      automationStatus: async () => ({
        ok: true,
        runId: "run-1",
        conversationId: "conversation-1",
        status: "succeeded",
        state: {terminal: "succeeded", finalResult: "success"},
      }),
      startAutomation: async (input) => {
        calls.push(input);
        return {ok: true, runId: input.runId, conversationId: "conversation-1", status: "running"};
      },
    },
  });

  await service.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "run the browser workflow");
  assert.equal(db.data.get("automationRuns/run-1").executionStartedAt, "SERVER_TIMESTAMP");
  await service.pollOnce();
  assert.equal(db.data.get("automationRuns/run-1").status, "succeeded");
  assert.equal(db.data.get("automationRuns/run-1").finalResult, "success");
  assert.equal(db.data.get("automationRuns/run-1").cleanupState, "pending");
});

test("rejects missing and invalid owner-resolved assignments", async () => {
  const missing = setup();
  missing.db.data.delete("automationRuns/run-1");
  await assert.rejects(() => missing.service.start(), /automation_assignment_missing/);

  const invalid = setup({run: {snapshot: {prompt: "", modelSelection: null}}});
  await assert.rejects(() => invalid.service.start(), /automation_assignment_prompt_missing/);
});

test("a failed status cannot be promoted to success", async () => {
  const {db, service} = setup({
    adapter: {
      automationStatus: async () => ({
        ok: true,
        runId: "run-1",
        status: "failed",
        state: {terminal: "succeeded", finalResult: "success"},
      }),
      startAutomation: async () => ({ok: true, runId: "run-1", status: "running"}),
    },
  });
  await service.start();
  await service.pollOnce();
  assert.equal(db.data.get("automationRuns/run-1").status, "failed");
  assert.equal(db.data.get("automationRuns/run-1").executionOutcome, "failed");
});

test("a claimed run interrupted during submit is never replayed", async () => {
  let submissions = 0;
  const first = setup({
    adapter: {
      automationStatus: async () => ({ok: true, status: "running"}),
      startAutomation: async () => {
        submissions += 1;
        throw Object.assign(new Error("submit failed"), {code: "automation_submit_failed"});
      },
    },
  });
  await assert.rejects(() => first.service.start(), /submit failed/);
  assert.equal(submissions, 1);
  assert.equal(first.db.data.get("automationRuns/run-1").status, "interrupted");

  const second = createAutomationExecutionService({
    admin,
    config: {
      agentRuntimeEnabled: true,
      automationRunId: "run-1",
      ownerUid: "user-1",
      runtimeKind: "automation",
      sessionId: "auto-run-1",
      workspaceId: "workspace-1",
    },
    db: first.db,
    piWebUi: {startAutomation: async () => { submissions += 1; }},
    workspaceAuthority: authority(),
  });
  const result = await second.start();
  assert.equal(result.skipped, "status_interrupted");
  assert.equal(submissions, 1);
});

test("a persisted claim from a lost boot is recovered as interrupted without submission", async () => {
  let submissions = 0;
  const {db} = setup({run: {
    executionBootInstanceId: "old-boot",
    executionGeneration: 6,
    executionStartedAt: "OLD_CLAIM",
    executionState: "claimed",
  }});
  const service = createAutomationExecutionService({
    admin,
    config: {
      agentRuntimeEnabled: true,
      automationRunId: "run-1",
      ownerUid: "user-1",
      runtimeKind: "automation",
      sessionId: "auto-run-1",
      workspaceId: "workspace-1",
    },
    db,
    piWebUi: {startAutomation: async () => { submissions += 1; }},
    workspaceAuthority: authority(),
  });

  const result = await service.start();
  assert.equal(result.interrupted, true);
  assert.equal(submissions, 0);
  assert.equal(db.data.get("automationRuns/run-1").status, "interrupted");
  assert.equal(db.data.get("automationRuns/run-1").executionErrorCode, "automation_execution_already_claimed");
});

test("runner shutdown cooperatively cancels submitted work and honors a committed stop", async () => {
  let canceled = 0;
  const {db, service} = setup({
    adapter: {
      automationStatus: async () => ({ok: true, runId: "run-1", status: "running"}),
      startAutomation: async () => ({ok: true, runId: "run-1", status: "running"}),
      cancelAutomation: async () => {
        canceled += 1;
        return {ok: true, runId: "run-1", status: "canceled"};
      },
    },
  });

  await service.start();
  db.data.get("automationRuns/run-1").status = "stopping";
  db.data.get("automationRuns/run-1").desiredOutcome = "canceled";
  db.data.get("automationRuns/run-1").cancellationRequestedAt = "STOP_REQUESTED";
  await service.stop({cancel: true});
  assert.equal(canceled, 1);
  assert.equal(db.data.get("automationRuns/run-1").status, "canceled");
  assert.equal(db.data.get("automationRuns/run-1").desiredOutcome, "canceled");
});

test("cleanup preserves a committed interruption instead of reporting user cancellation", async () => {
  const {db, service} = setup({
    adapter: {
      automationStatus: async () => ({ok: true, runId: "run-1", status: "running"}),
      startAutomation: async () => ({ok: true, runId: "run-1", status: "running"}),
      cancelAutomation: async () => ({ok: true, runId: "run-1", status: "canceled"}),
    },
  });
  await service.start();
  Object.assign(db.data.get("automationRuns/run-1"), {
    status: "stopping", desiredOutcome: "interrupted", interruptionReason: "runner_request_failed",
  });
  await service.stop({cancel: true});
  const run = db.data.get("automationRuns/run-1");
  assert.equal(run.status, "interrupted");
  assert.equal(run.desiredOutcome, "interrupted");
  assert.equal(run.executionErrorCode, "runner_request_failed");
});
