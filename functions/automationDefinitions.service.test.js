"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createAutomationDefinitionsService} = require("./automationDefinitions.service");

class FakeSnapshot {
  constructor(ref, data) {
    this.id = ref.id;
    this.ref = ref;
    this.exists = data !== undefined;
    this._data = data;
  }

  data() {
    return this._data;
  }
}

class FakeRef {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }

  async get() {
    return new FakeSnapshot(this, this.db.data.get(this.path));
  }

  async set(data) {
    this.db.data.set(this.path, {...data});
  }

  async update(data) {
    const current = this.db.data.get(this.path) || {};
    this.db.data.set(this.path, {...current, ...data});
  }

  collection(name) {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }
}

class FakeQuery {
  constructor(collection, predicates = []) {
    this.collection = collection;
    this.predicates = predicates;
  }

  where(field, operator, value) {
    assert.equal(operator, "==");
    return new FakeQuery(this.collection, [...this.predicates, {field, value}]);
  }

  async get() {
    return this.collection.snapshot(this.predicates);
  }
}

class FakeCollection extends FakeQuery {
  constructor(db, path, predicates = []) {
    super({db, path, snapshot: (nextPredicates) => this.snapshot(nextPredicates)}, predicates);
    this.db = db;
    this.path = path;
    this.predicates = predicates;
    this.collection = this;
  }

  doc(id = "") {
    const nextId = id || `generated-${++this.db.generatedId}`;
    return new FakeRef(this.db, `${this.path}/${nextId}`, nextId);
  }

  where(field, operator, value) {
    assert.equal(operator, "==");
    return new FakeQuery(this, [...this.predicates, {field, value}]);
  }

  async get() {
    return this.snapshot(this.predicates);
  }

  snapshot(predicates = []) {
    const prefix = `${this.path}/`;
    const docs = [];
    for (const [path, data] of this.db.data.entries()) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) continue;
      if (!predicates.every(({field, value}) => data && data[field] === value)) continue;
      docs.push(new FakeSnapshot(new FakeRef(this.db, path, path.slice(prefix.length)), data));
    }
    return {docs};
  }
}

class FakeDb {
  constructor() {
    this.data = new Map();
    this.generatedId = 0;
  }

  collection(name) {
    return new FakeCollection(this, name);
  }

  async runTransaction(callback) {
    const transaction = {
      get: (target) => target.get(),
      set: (ref, data) => ref.set(data),
      update: (ref, data) => ref.update(data),
    };
    return callback(transaction);
  }
}

function createHarness() {
  const db = new FakeDb();
  const admin = {
    firestore: {
      FieldValue: {serverTimestamp: () => `timestamp-${db.generatedId + 1}`},
    },
  };
  const workspaceRef = db.collection("workspaces").doc("workspace-1");
  const userRef = db.collection("users").doc("user-1");
  db.data.set(workspaceRef.path, {
    ownerUid: "user-1",
    sharedStorageState: "legacy",
    automationModelSelection: {modelId: "model-1", providerId: "provider-1"},
  });
  db.data.set(userRef.path, {timezone: "America/Chicago"});
  return {db, service: createAutomationDefinitionsService({admin, db})};
}

test("automation definition CRUD is owner-scoped, revisioned, and redacts server fields", async () => {
  const {db, service} = createHarness();
  const created = await service.createAutomation("user-1", "workspace-1", {
    name: "Daily report",
    prompt: "Summarize the workspace",
    cron: "0 10 * * *",
  });
  assert.equal(created.enabled, false);
  assert.equal(created.allowParallelWithMain, true);
  assert.equal(created.timezone, "America/Chicago");
  assert.deepEqual(created.modelSelection, {modelId: "model-1", providerId: "provider-1"});
  assert.equal(created.revision, 1);
  assert.equal(created.ownerUid, undefined);
  assert.equal(created.automationSecret, undefined);

  await assert.rejects(
      service.createAutomation("user-2", "workspace-1", {
        name: "No access", prompt: "nope", cron: "0 10 * * *", timezone: "UTC",
      }),
      (error) => error.status === 403 && error.publicMessage === "workspace_forbidden",
  );
  await assert.rejects(
      service.updateAutomation("user-1", "workspace-1", created.id, {expectedRevision: 2, name: "stale"}),
      (error) => error.status === 409 && error.publicMessage === "revision_conflict",
  );

  const runCollection = db.collection("automationRuns");
  await runCollection.doc("run-queued").set({
    automationId: created.id, workspaceId: "workspace-1", status: "queued", snapshot: {prompt: "original"},
  });
  await runCollection.doc("run-active").set({
    automationId: created.id, workspaceId: "workspace-1", status: "running", snapshot: {prompt: "original"},
  });

  const edited = await service.updateAutomation("user-1", "workspace-1", created.id, {
    expectedRevision: 1,
    prompt: "Updated summary",
  });
  assert.equal(edited.revision, 2);
  assert.equal(db.data.get("automationRuns/run-active").snapshot.prompt, "original");
  assert.equal(db.data.get("automationRuns/run-queued").status, "queued");

  db.data.get("workspaces/workspace-1").sharedStorageState = "ready";
  const enabled = await service.updateAutomation("user-1", "workspace-1", created.id, {
    expectedRevision: 2,
    enabled: true,
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.revision, 3);

  await runCollection.doc("run-queued-2").set({
    automationId: created.id, workspaceId: "workspace-1", status: "queued", snapshot: {prompt: "enabled"},
  });
  const disabled = await service.updateAutomation("user-1", "workspace-1", created.id, {
    expectedRevision: 3,
    enabled: false,
  });
  assert.equal(disabled.nextRunAt, null);
  assert.equal(db.data.get("automationRuns/run-queued-2").status, "canceled");
  assert.equal(db.data.get("automationRuns/run-active").status, "running");

  const deleted = await service.deleteAutomation("user-1", "workspace-1", created.id, {expectedRevision: 4});
  assert.deepEqual(deleted, {ok: true});
  assert.deepEqual(await service.listAutomations("user-1", "workspace-1"), []);
  const tombstone = await service.getAutomation("user-1", "workspace-1", created.id);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.ownerUid, undefined);

  const auditPaths = [...db.data.keys()].filter((path) => path.startsWith(`workspaces/workspace-1/automations/${created.id}/audit/`));
  assert.equal(auditPaths.length, 5);
  for (const path of auditPaths) {
    const audit = db.data.get(path);
    assert.equal(audit.actorType, "user");
    assert.deepEqual(audit.changedFields.filter((field) => /secret|token|credential/i.test(field)), []);
  }
});

test("automation settings use default one and preserve active allocations when lowered", async () => {
  const {db, service} = createHarness();
  assert.deepEqual(await service.getAutomationSettings("user-1", "workspace-1"), {automationMaxConcurrency: 1});
  assert.deepEqual(await service.updateAutomationSettings("user-1", "workspace-1", {automationMaxConcurrency: 3}), {
    automationMaxConcurrency: 3,
  });
  assert.deepEqual(await service.updateAutomationSettings("user-1", "workspace-1", {automationMaxConcurrency: 1}), {
    automationMaxConcurrency: 1,
  });
  assert.equal(db.data.get("workspaces/workspace-1").automationMaxConcurrency, 1);
});
