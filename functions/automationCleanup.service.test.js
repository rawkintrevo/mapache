"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAutomationCleanupService,
} = require("./automationCleanup.service");

const admin = {firestore: {FieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"}}};

class Ref {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }

  async get() {
    const value = this.db.data.get(this.path);
    return {exists: value !== undefined, id: this.id, ref: this, data: () => value};
  }

  async update(updates) {
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

function run(overrides = {}) {
  return {
    runId: "run-1",
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    automationId: "automation-1",
    sessionId: "auto-run-1",
    status: "running",
    cleanupState: "pending",
    snapshot: {prompt: "run it"},
    ...overrides,
  };
}

function harness({runData = run(), deleteResult = {serviceAbsent: true}} = {}) {
  const db = new Db();
  db.data.set("workspaces/workspace-1", {ownerUid: "user-1"});
  db.data.set("workspaces/workspace-1/automations/automation-1", {pendingRunId: "run-1"});
  db.data.set("automationRuns/run-1", runData);
  db.data.set("workspaces/workspace-1/sessions/auto-run-1", {
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    runtimeKind: "automation",
    automationRunId: "run-1",
    status: "running",
  });
  const calls = [];
  const service = createAutomationCleanupService({
    admin,
    db,
    deleteSessionService: async (sessionRef, session, options) => {
      calls.push({sessionRef, session, options});
      return deleteResult;
    },
    releaseAutomationSlot: async (runId, options) => {
      calls.push({runId, options});
      return {released: true, workspaceId: "workspace-1"};
    },
    sessionCollection: (workspaceId) => db.collection(`workspaces/${workspaceId}/sessions`),
    wakeQueue: async () => {},
  });
  return {calls, db, service};
}

test("stop cancels an active run, deletes only its runner, and releases the slot", async () => {
  const {calls, db, service} = harness();
  const stopped = await service.stopRun({uid: "user-1"}, "run-1");
  const saved = db.data.get("automationRuns/run-1");
  assert.equal(stopped.status, "canceled");
  assert.equal(saved.status, "canceled");
  assert.equal(saved.cleanupState, "complete");
  assert.equal(saved.persistenceState, "complete");
  assert.equal(calls[0].options.reason, "automation_cleanup");
  assert.equal(calls[0].options.skipSessionState, false);
  assert.equal(calls.at(-1).options.serviceAbsent, true);
});

test("cleanup failure keeps a stopping run and its reservation", async () => {
  const {calls, db, service} = harness({deleteResult: {serviceAbsent: false}});
  const stopped = await service.stopRun({uid: "user-1"}, "run-1");
  const saved = db.data.get("automationRuns/run-1");
  assert.equal(stopped.status, "stopping");
  assert.equal(saved.status, "stopping");
  assert.equal(saved.cleanupState, "error");
  assert.equal(calls.length, 1);
});

test("queued stop is atomic and does not create a Cloud Run deletion", async () => {
  const {calls, db, service} = harness({runData: run({status: "queued", cleanupState: "pending"})});
  const stopped = await service.stopRun({uid: "user-1"}, "run-1");
  assert.equal(stopped.status, "canceled");
  assert.equal(db.data.get("workspaces/workspace-1/automations/automation-1").pendingRunId, null);
  assert.equal(calls.length, 0);
});

test("repeated stop after completed cleanup is idempotent", async () => {
  const {calls, service} = harness({runData: run({status: "canceled", cleanupState: "complete"})});
  const stopped = await service.stopRun({uid: "user-1"}, "run-1");
  assert.equal(stopped.status, "canceled");
  assert.equal(calls.length, 0);
});

console.log("automation cleanup service tests passed");
