"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {runAutomationSchedulerTick} = require("./automationScheduler.service");

const admin = {
  firestore: {
    FieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"},
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
  constructor(db, path, id, parent = null) {
    this.db = db;
    this.path = path;
    this.id = id;
    this.parent = parent;
  }

  collection(name) {
    return new Collection(this.db, `${this.path}/${name}`, name, this);
  }
}

class Collection extends Ref {
  constructor(db, path, id, parent) {
    super(db, path, id, parent);
  }

  doc(id) {
    return new Ref(this.db, `${this.path}/${id}`, id, this);
  }

  where(field, operator, value) {
    return new Query(this.db, this.path, this.id, this.parent, [{field, operator, value}]);
  }

  async get() {
    return new QuerySnapshot(this.db.directDocs(this.path));
  }
}

class Query extends Collection {
  constructor(db, path, id, parent, filters = [], options = {}) {
    super(db, path, id, parent);
    this.filters = filters;
    this.options = options;
  }

  where(field, operator, value) {
    return new Query(this.db, this.path, this.id, this.parent, [...this.filters, {field, operator, value}], this.options);
  }

  orderBy(field, direction) {
    return new Query(this.db, this.path, this.id, this.parent, this.filters, {...this.options, order: {field, direction}});
  }

  limit(value) {
    return new Query(this.db, this.path, this.id, this.parent, this.filters, {...this.options, limit: value});
  }

  startAfter(doc) {
    return new Query(this.db, this.path, this.id, this.parent, this.filters, {...this.options, after: doc?.ref?.path});
  }

  async get() {
    let docs = this.path === "automation-group" ? this.db.collectionGroupDocs("automations") : this.db.directDocs(this.path);
    docs = docs.filter(({value}) => this.filters.every(({field, operator, value: expected}) => {
      if (operator === "==") return value?.[field] === expected;
      if (operator === "<=") return toMillis(value?.[field]) <= toMillis(expected);
      return false;
    }));
    if (this.options.order) {
      const {field} = this.options.order;
      docs.sort((left, right) => toMillis(left.value?.[field]) - toMillis(right.value?.[field]));
    }
    if (this.options.after) {
      const index = docs.findIndex(({ref}) => ref.path === this.options.after);
      if (index >= 0) docs = docs.slice(index + 1);
    }
    if (this.options.limit) docs = docs.slice(0, this.options.limit);
    return new QuerySnapshot(docs.map(({ref, value}) => new Snapshot(ref, value)));
  }
}

class FakeDb {
  constructor() {
    this.data = new Map();
  }

  collection(name) {
    return new Collection(this, name, name, null);
  }

  collectionGroup(name) {
    return new Query(this, "automation-group", name, null);
  }

  directDocs(path) {
    const prefix = `${path}/`;
    return [...this.data.entries()]
        .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
        .map(([key, value]) => ({ref: this.refFor(key), value: clone(value)}));
  }

  collectionGroupDocs(collectionName) {
    return [...this.data.entries()]
        .filter(([key]) => key.split("/").at(-2) === collectionName)
        .map(([key, value]) => ({ref: this.refFor(key), value: clone(value)}));
  }

  refFor(path) {
    const pieces = path.split("/");
    let parent = null;
    let current = "";
    for (let index = 0; index < pieces.length; index++) {
      current = current ? `${current}/${pieces[index]}` : pieces[index];
      if (index % 2 === 0) parent = new Collection(this, current, pieces[index], parent);
      else parent = new Ref(this, current, pieces[index], parent);
    }
    return parent;
  }

  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: async (target) => {
        if (target instanceof Query || target instanceof Collection) return target.get();
        return new Snapshot(target, clone(this.data.get(target.path)));
      },
      set: (ref, value) => writes.push({kind: "set", ref, value: clone(value)}),
      update: (ref, value) => writes.push({kind: "update", ref, value: clone(value)}),
    };
    const result = await callback(transaction);
    for (const write of writes) {
      if (write.kind === "set") this.data.set(write.ref.path, write.value);
      else this.data.set(write.ref.path, {...(this.data.get(write.ref.path) || {}), ...write.value});
    }
    return result;
  }
}

function clone(value) {
  if (value === undefined || value === null) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  const result = new Date(value).getTime();
  return Number.isNaN(result) ? 0 : result;
}

function setup({nextRunAt = "2026-09-20T10:00:00.000Z", pendingRunId = null, cron = "0 10 * * *"} = {}) {
  const db = new FakeDb();
  db.data.set("appConfig/automations", {enabled: true});
  db.data.set("workspaces/workspace-1", {resources: {cpu: "1", memory: "2Gi"}});
  db.data.set("workspaces/workspace-1/automations/automation-1", {
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    name: "Daily report",
    prompt: "Summarize",
    definitionRevision: 3,
    revision: 3,
    cron,
    timezone: "UTC",
    allowParallelWithMain: true,
    modelSelection: {modelId: "model-1", providerId: "provider-1"},
    resources: null,
    enabled: true,
    deleted: false,
    nextRunAt,
    pendingRunId,
  });
  if (pendingRunId) {
    db.data.set(`automationRuns/${pendingRunId}`, {
      status: "running",
      cleanupState: "pending",
    });
  }
  return db;
}

const tick = "2026-09-20T10:00:00.000Z";

test("disabled scheduler does not backfill or query definitions", async () => {
  const db = setup();
  const result = await runAutomationSchedulerTick({scheduleTime: tick}, {
    db,
    admin,
    featureEnabled: async () => false,
  });
  assert.equal(result.skippedReason, "disabled");
  assert.equal(db.data.get("workspaces/workspace-1/automations/automation-1").nextRunAt, tick.replace("10:00", "10:00"));
});

test("timely tick enqueues one deterministic occurrence and advances the pointer", async () => {
  const db = setup();
  const result = await runAutomationSchedulerTick({scheduleTime: tick}, {
    db,
    admin,
    now: () => new Date(tick),
    featureEnabled: async () => true,
  });
  assert.equal(result.queued, 1);
  const runs = [...db.data.entries()].filter(([path]) => path.startsWith("automationRuns/") && path !== "automationRuns/unused");
  assert.equal(runs.length, 1);
  const run = runs[0][1];
  assert.equal(run.trigger, "cron");
  assert.equal(run.occurrence.local, "2026-09-20T10:00");
  assert.equal(db.data.get("workspaces/workspace-1/automations/automation-1").pendingRunId, runs[0][0].split("/")[1]);
  const duplicate = await runAutomationSchedulerTick({scheduleTime: tick}, {
    db,
    admin,
    now: () => new Date(tick),
    featureEnabled: async () => true,
  });
  assert.equal(duplicate.queued, 0);
  assert.equal([...db.data.keys()].filter((path) => path.startsWith("automationRuns/")).length, 1);
});

test("late delivery is ignored without advancing schedules", async () => {
  const db = setup();
  const before = db.data.get("workspaces/workspace-1/automations/automation-1").nextRunAt;
  const result = await runAutomationSchedulerTick({scheduleTime: tick}, {
    db,
    admin,
    now: () => new Date("2026-09-20T10:03:00.001Z"),
    featureEnabled: async () => true,
  });
  assert.equal(result.skippedReason, "late_delivery");
  assert.equal(db.data.get("workspaces/workspace-1/automations/automation-1").nextRunAt, before);
});

test("missed recovery records one skipped range and queues only the current occurrence", async () => {
  const db = setup({nextRunAt: "2026-09-20T09:00:00.000Z"});
  const result = await runAutomationSchedulerTick({scheduleTime: tick}, {
    db,
    admin,
    now: () => new Date(tick),
    featureEnabled: async () => true,
  });
  assert.equal(result.queued, 1);
  assert.equal(result.missedRanges, 1);
  const runs = [...db.data.entries()].filter(([path]) => path.startsWith("automationRuns/")).map(([, value]) => value);
  assert.equal(runs.filter((run) => run.skippedReason === "missed_range").length, 1);
  assert.equal(runs.filter((run) => run.status === "queued").length, 1);
});

test("a pending run produces skipped cron history instead of another queued run", async () => {
  const db = setup({pendingRunId: "existing-run"});
  const result = await runAutomationSchedulerTick({scheduleTime: tick}, {
    db,
    admin,
    now: () => new Date(tick),
    featureEnabled: async () => true,
  });
  assert.equal(result.queued, 0);
  assert.equal(result.skipped, 1);
  assert.equal([...db.data.entries()].filter(([path]) => path.startsWith("automationRuns/")).length, 2);
});
