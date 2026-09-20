"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  cancelQueuedRun,
  deterministicCronRunId,
  enqueueRun,
  restartRun,
} = require("./automationRuns.service");

class Snapshot {
  constructor(ref, data) {
    this.id = ref.id;
    this.ref = ref;
    this._data = data;
    this.exists = data !== undefined;
  }

  data() {
    return this._data;
  }
}

class Ref {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }

  async get() {
    return new Snapshot(this, this.db.data.get(this.path));
  }

  async set(value) {
    this.db.data.set(this.path, {...value});
  }

  async update(value) {
    this.db.data.set(this.path, {...(this.db.data.get(this.path) || {}), ...value});
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

  doc(id = "") {
    const nextId = id || `generated-${++this.db.generatedId}`;
    return new Ref(this.db, `${this.path}/${nextId}`, nextId);
  }
}

class Db {
  constructor() {
    this.data = new Map();
    this.generatedId = 0;
  }

  collection(name) {
    return new Collection(this, name);
  }

  async runTransaction(callback) {
    const transaction = {
      get: (ref) => ref.get(),
      set: (ref, value) => ref.set(value),
      update: (ref, value) => ref.update(value),
    };
    return callback(transaction);
  }
}

function harness() {
  const db = new Db();
  const admin = {firestore: {FieldValue: {serverTimestamp: () => "server-time"}}};
  const workspace = db.collection("workspaces").doc("workspace-1");
  const definition = workspace.collection("automations").doc("automation-1");
  db.data.set(workspace.path, {
    ownerUid: "user-1",
    resources: {cpu: "2", memory: "4Gi"},
    sharedStorageState: "ready",
  });
  db.data.set(definition.path, {
    ownerUid: "user-1",
    name: "Daily report",
    prompt: "Summarize the workspace",
    enabled: false,
    cron: "0 10 * * *",
    timezone: "America/Chicago",
    allowParallelWithMain: true,
    modelSelection: {modelId: "model-1", providerId: "provider-1"},
    resources: null,
    revision: 3,
    deleted: false,
    pendingRunId: null,
  });
  return {admin, db, definition, workspace};
}

function runAt(db, id) {
  return db.data.get(`automationRuns/${id}`);
}

test("manual and cron enqueue capture immutable snapshots and deduplicate", async () => {
  const {admin, db, definition} = harness();
  const first = await enqueueRun({
    actor: {uid: "user-1"}, aid: "automation-1", trigger: "manual", wid: "workspace-1",
  }, {admin, db});
  assert.equal(first.status, "queued");
  assert.equal(first.snapshot.prompt, "Summarize the workspace");
  await definition.update({prompt: "Edited later", revision: 4});
  assert.equal(runAt(db, first.id).snapshot.prompt, "Summarize the workspace");

  const occurrence = {local: "2026-09-20T10:00", timezone: "America/Chicago"};
  const cron = await enqueueRun({
    actor: {uid: "user-1"}, aid: "automation-1", occurrence, trigger: "cron", wid: "workspace-1",
  }, {admin, db});
  assert.equal(cron.id, deterministicCronRunId("automation-1", occurrence));
  const duplicate = await enqueueRun({
    actor: {uid: "user-1"}, aid: "automation-1", occurrence, trigger: "cron", wid: "workspace-1",
  }, {admin, db});
  assert.equal(duplicate.id, cron.id);
});

test("queue admission skips cron work but rejects manual and restart work", async () => {
  const {admin, db} = harness();
  const pending = await enqueueRun({
    actor: {uid: "user-1"}, aid: "automation-1", trigger: "manual", wid: "workspace-1",
  }, {admin, db});
  await assert.rejects(
      enqueueRun({actor: {uid: "user-1"}, aid: "automation-1", trigger: "manual", wid: "workspace-1"}, {admin, db}),
      (error) => error.status === 409 && error.publicMessage === "pending_run_exists",
  );
  const skipped = await enqueueRun({
    actor: {uid: "user-1"}, aid: "automation-1", trigger: "cron", wid: "workspace-1",
    occurrence: {local: "2026-09-20T11:00", timezone: "America/Chicago"},
  }, {admin, db});
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.skippedReason, "queue_full");
  assert.equal(pending.status, "queued");
});

test("manual idempotency keys are scoped and digest protected", async () => {
  const {admin, db, definition} = harness();
  const first = await enqueueRun({
    actor: {uid: "user-1"}, aid: "automation-1", trigger: "manual", wid: "workspace-1", idempotencyKey: "request-1",
  }, {admin, db});
  const duplicate = await enqueueRun({
    actor: {uid: "user-1"}, aid: "automation-1", trigger: "manual", wid: "workspace-1", idempotencyKey: "request-1",
  }, {admin, db});
  assert.equal(duplicate.id, first.id);
  await definition.update({prompt: "Different request", revision: 4});
  await assert.rejects(
      enqueueRun({
        actor: {uid: "user-1"}, aid: "automation-1", trigger: "manual", wid: "workspace-1", idempotencyKey: "request-1",
      }, {admin, db}),
      (error) => error.status === 409 && error.publicMessage === "idempotency_key_reused",
  );
});

test("restart uses a terminal historical snapshot even after definition tombstoning", async () => {
  const {admin, db, definition} = harness();
  db.data.set("automationRuns/old-run", {
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    automationId: "automation-1",
    status: "succeeded",
    snapshot: {
      name: "Old report", prompt: "Old prompt", definitionRevision: 2,
      cron: "0 10 * * *", timezone: "America/Chicago", allowParallelWithMain: true,
      modelSelection: {modelId: "old-model", providerId: "provider-1"}, resources: {cpu: "1", memory: "2Gi"},
    },
  });
  await definition.update({deleted: true});
  const restarted = await restartRun({uid: "user-1"}, "old-run", {}, {admin, db});
  assert.equal(restarted.status, "queued");
  assert.equal(restarted.restartOfRunId, "old-run");
  assert.equal(restarted.snapshot.prompt, "Old prompt");
  assert.equal(db.data.get(definition.path).pendingRunId, null);
  db.data.get("automationRuns/old-run").status = "running";
  await assert.rejects(
      restartRun({uid: "user-1"}, "old-run", {}, {admin, db}),
      (error) => error.status === 409 && error.publicMessage === "automation_run_active",
  );
});

test("cancel clears the definition pointer only for its queued run", async () => {
  const {admin, db, definition} = harness();
  const queued = await enqueueRun({
    actor: {uid: "user-1"}, aid: "automation-1", trigger: "manual", wid: "workspace-1",
  }, {admin, db});
  const canceled = await cancelQueuedRun({uid: "user-1"}, queued.id, {admin, db});
  assert.equal(canceled.status, "canceled");
  assert.equal(db.data.get(definition.path).pendingRunId, null);
  assert.equal(runAt(db, queued.id).status, "canceled");
});

console.log("automation run service tests passed");
