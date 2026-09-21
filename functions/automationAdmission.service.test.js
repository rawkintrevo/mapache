"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  admitNextEligibleRun,
  assertMainAdmissionAllowed,
  createAutomationAdmissionService,
  releaseAfterCleanup,
  wakeQueue,
} = require("./automationAdmission.service");

const DELETE = Symbol("delete");
const admin = {
  firestore: {
    FieldValue: {
      delete: () => DELETE,
      serverTimestamp: () => "SERVER_TIMESTAMP",
    },
  },
};

class Snapshot {
  constructor(ref, value) {
    this.id = ref.id;
    this.ref = ref;
    this.exists = value !== undefined;
    this._value = value;
  }

  data() {
    return this._value;
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
  }
}

class Ref {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }

  async get() {
    return new Snapshot(this, this.db.read(this.path));
  }

  collection(name) {
    return new Collection(this.db, `${this.path}/${name}`);
  }
}

class Collection extends Ref {
  constructor(db, path) {
    super(db, path, path.split("/").pop());
  }

  doc(id) {
    return new Ref(this.db, `${this.path}/${id}`, id);
  }

  where(field, operator, value) {
    assert.equal(operator, "==");
    return new Query(this.db, this.path, field, value);
  }

  async get() {
    return new QuerySnapshot(this.db.collectionDocs(this.path).map(({ref, value}) => new Snapshot(ref, value)));
  }
}

class Query extends Collection {
  constructor(db, path, field, value) {
    super(db, path);
    this.field = field;
    this.value = value;
  }

  async get() {
    return new QuerySnapshot(this.db.collectionDocs(this.path)
        .filter(({value}) => value && value[this.field] === this.value)
        .map(({ref, value}) => new Snapshot(ref, value)));
  }
}

class FakeDb {
  constructor() {
    this.data = new Map();
    this.version = 0;
  }

  collection(name) {
    return new Collection(this, name);
  }

  read(path) {
    const value = this.data.get(path);
    return value === undefined ? undefined : clone(value);
  }

  collectionDocs(prefix) {
    const slash = `${prefix}/`;
    return [...this.data.entries()]
        .filter(([path]) => path.startsWith(slash) && !path.slice(slash.length).includes("/"))
        .map(([path, value]) => ({ref: new Ref(this, path, path.slice(slash.length)), value: clone(value)}));
  }

  async runTransaction(callback) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const readVersion = this.version;
      const writes = [];
      const transaction = {
        get: async (ref) => {
          await new Promise((resolve) => setImmediate(resolve));
          if (typeof ref.get === "function" && !(ref instanceof Ref || ref instanceof Collection || ref instanceof Query)) {
            return ref.get();
          }
          if (ref instanceof Query) return ref.get();
          if (ref instanceof Collection) return ref.get();
          return new Snapshot(ref, this.read(ref.path));
        },
        update: (ref, value) => writes.push({kind: "update", ref, value: clone(value)}),
        set: (ref, value) => writes.push({kind: "set", ref, value: clone(value)}),
      };
      const result = await callback(transaction);
      if (readVersion !== this.version) continue;
      for (const write of writes) {
        if (write.kind === "set") this.data.set(write.ref.path, write.value);
        else {
          const current = this.data.get(write.ref.path) || {};
          for (const [key, value] of Object.entries(write.value)) {
            if (value === DELETE) delete current[key];
            else current[key] = value;
          }
          this.data.set(write.ref.path, current);
        }
      }
      this.version++;
      return result;
    }
    throw new Error("fake_transaction_retry_limit");
  }
}

function clone(value) {
  if (value === DELETE || value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function harness({limit = 1, mainStatus = "stopped", runs = []} = {}) {
  const db = new FakeDb();
  db.data.set("workspaces/workspace-1", {
    ownerUid: "user-1",
    automationMaxConcurrency: limit,
    activeChromeSessionId: mainStatus ? "main" : null,
  });
  if (mainStatus) db.data.set("workspaces/workspace-1/sessions/main", {status: mainStatus});
  for (const run of runs) {
    db.data.set(`automationRuns/${run.runId}`, {
      workspaceId: "workspace-1",
      automationId: run.automationId || "automation-1",
      status: "queued",
      cleanupState: "pending",
      createdAt: run.createdAt || "2026-09-20T10:00:00.000Z",
      runId: run.runId,
      snapshot: {allowParallelWithMain: run.allowParallelWithMain !== false},
    });
    db.data.set(`workspaces/workspace-1/automations/${run.automationId || "automation-1"}`, {
      pendingRunId: run.pendingRunId ? run.runId : null,
    });
  }
  return db;
}

test("admits only one concurrent run at the limit and clears its pending pointer", async () => {
  const db = harness({limit: 1, runs: [
    {runId: "run-a", pendingRunId: true},
    {runId: "run-b", createdAt: "2026-09-20T10:01:00.000Z"},
  ]});
  const outcomes = await Promise.all([
    admitNextEligibleRun("workspace-1", {db, admin}),
    admitNextEligibleRun("workspace-1", {db, admin}),
  ]);
  assert.equal(outcomes.filter((result) => result.admitted).length, 1);
  assert.equal(db.read("automationRuns/run-a").status, "provisioning");
  assert.equal(db.read("automationRuns/run-b").status, "queued");
  assert.equal(db.read("workspaces/workspace-1/automations/automation-1").pendingRunId, null);
  assert.deepEqual(db.read("workspaces/workspace-1").automationActiveRunIds, ["run-a"]);
});

test("skips an older main-exclusive run when a later parallel run fits", async () => {
  const db = harness({mainStatus: "running", runs: [
    {runId: "run-exclusive", allowParallelWithMain: false, pendingRunId: true},
    {runId: "run-parallel", allowParallelWithMain: true},
  ]});
  const result = await admitNextEligibleRun("workspace-1", {db, admin});
  assert.equal(result.runId, "run-parallel");
  assert.equal(db.read("automationRuns/run-exclusive").status, "queued");
  assert.equal(db.read("automationRuns/run-parallel").status, "provisioning");
  assert.equal(db.read("workspaces/workspace-1").automationMainExclusionRunId, undefined);
});

test("holds a main exclusion until the main is stopped and then admits the oldest blocked run", async () => {
  const db = harness({mainStatus: "running", runs: [
    {runId: "run-exclusive", allowParallelWithMain: false},
  ]});
  const blocked = await admitNextEligibleRun("workspace-1", {db, admin});
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.reason, "main_requires_pause");
  db.data.set("workspaces/workspace-1/sessions/main", {status: "stopped"});
  const admitted = await admitNextEligibleRun("workspace-1", {db, admin});
  assert.equal(admitted.runId, "run-exclusive");
  assert.equal(db.read("workspaces/workspace-1").automationMainExclusionRunId, "run-exclusive");
  assert.throws(() => assertMainAdmissionAllowed(db.read("workspaces/workspace-1")), /automation_requires_main_paused/);
});

test("lowering the limit never evicts active runs and failed cleanup retains the slot", async () => {
  const db = harness({limit: 1, runs: [{runId: "run-active"}]});
  await admitNextEligibleRun("workspace-1", {db, admin});
  db.data.get("workspaces/workspace-1").automationMaxConcurrency = 0;
  const blocked = await admitNextEligibleRun("workspace-1", {db, admin});
  assert.equal(blocked.reason, "concurrency_limit");
  db.data.set("automationRuns/run-active", {
    ...db.read("automationRuns/run-active"), status: "succeeded", cleanupState: "pending",
  });
  await assert.rejects(
      releaseAfterCleanup("run-active", {serviceAbsent: false}, {db, admin}),
      /automation_cleanup_not_confirmed/,
  );
  assert.deepEqual(db.read("workspaces/workspace-1").automationActiveRunIds, ["run-active"]);
});

test("confirmed cleanup releases the slot and wakes the next eligible run", async () => {
  const db = harness({limit: 1, runs: [
    {runId: "run-active"},
    {runId: "run-next", createdAt: "2026-09-20T10:01:00.000Z"},
  ]});
  await admitNextEligibleRun("workspace-1", {db, admin});
  db.data.set("automationRuns/run-active", {
    ...db.read("automationRuns/run-active"), status: "succeeded", cleanupState: "complete",
  });
  const released = await releaseAfterCleanup("run-active", {serviceAbsent: true}, {db, admin});
  assert.equal(released.released, true);
  assert.equal(db.read("automationRuns/run-next").status, "provisioning");
  assert.deepEqual(db.read("workspaces/workspace-1").automationActiveRunIds, ["run-next"]);
});

test("wakeQueue admits every run that fits without duplicating reservations", async () => {
  const db = harness({limit: 2, runs: [
    {runId: "run-a"},
    {runId: "run-b", createdAt: "2026-09-20T10:01:00.000Z"},
    {runId: "run-c", createdAt: "2026-09-20T10:02:00.000Z"},
  ]});
  const service = createAutomationAdmissionService({db, admin});
  const result = await service.wakeQueue("workspace-1");
  assert.deepEqual(result.admitted.map((item) => item.runId), ["run-a", "run-b"]);
  assert.equal(db.read("automationRuns/run-c").status, "queued");
  const second = await wakeQueue("workspace-1", {db, admin});
  assert.deepEqual(second.admitted, []);
});

