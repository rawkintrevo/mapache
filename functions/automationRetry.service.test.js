"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createAutomationRetryService, retryEligibility} = require("./automationRetry.service");

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

  async update(updates) {
    this.db.data.set(this.path, {...(this.db.data.get(this.path) || {}), ...updates});
  }
}

class Query {
  constructor(db, path, predicates = []) {
    this.db = db;
    this.path = path;
    this.predicates = predicates;
  }

  where(field, operator, value) {
    return new Query(this.db, this.path, [...this.predicates, {field, operator, value}]);
  }

  limit() {
    return this;
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [...this.db.data.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .filter(([, value]) => this.predicates.every(({field, operator, value: expected}) =>
          operator === "in" ? expected.includes(value?.[field]) : value?.[field] === expected,
        ))
        .map(([path, value]) => new Doc(this.db, path, path.slice(prefix.length), value));
    return {docs};
  }
}

class Doc extends Ref {
  constructor(db, path, id, value) {
    super(db, path, id);
    this.value = value;
    this.ref = this;
  }

  data() {
    return this.value;
  }
}

class Db {
  constructor() {
    this.data = new Map();
  }

  collection(name) {
    return {
      doc: (id) => new Ref(this, `${name}/${id}`, id),
      where: (field, operator, value) => new Query(this, name).where(field, operator, value),
    };
  }

  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: (target) => target.get(),
      update: (ref, updates) => writes.push({ref, updates}),
    };
    const result = await callback(transaction);
    for (const write of writes) await write.ref.update(write.updates);
    return result;
  }
}

function failedRun(overrides = {}) {
  return {
    runId: "root-run",
    ownerUid: "owner-a",
    workspaceId: "workspace-a",
    automationId: "automation-a",
    status: "failed",
    cleanupState: "complete",
    retryPolicy: "safe",
    maximumRetries: 2,
    replaySafe: true,
    attemptNumber: 0,
    snapshot: {retryPolicy: "safe", maximumRetries: 2, replaySafe: true},
    ...overrides,
  };
}

function setup(run = failedRun()) {
  const db = new Db();
  db.data.set("automationRuns/root-run", run);
  return db;
}

test("schedules opt-in safe retries with bounded five and fifteen minute delays", async () => {
  const db = setup();
  const service = createAutomationRetryService({
    admin,
    db,
    now: () => Date.parse("2026-09-20T12:00:00.000Z"),
  });
  const first = await service.scheduleRetry("root-run");
  assert.equal(first.attemptNumber, 1);
  assert.equal(db.data.get("automationRuns/root-run").retryNotBefore.toISOString(), "2026-09-20T12:05:00.000Z");
  const second = await service.scheduleRetry("root-run");
  assert.equal(second.reason, "scheduled");

  db.data.get("automationRuns/root-run").attemptNumber = 1;
  db.data.get("automationRuns/root-run").retryState = null;
  const later = createAutomationRetryService({
    admin,
    db,
    now: () => Date.parse("2026-09-20T12:00:00.000Z"),
  });
  const retry = await later.scheduleRetry("root-run");
  assert.equal(retry.attemptNumber, 2);
  assert.equal(db.data.get("automationRuns/root-run").retryNotBefore.toISOString(), "2026-09-20T12:15:00.000Z");
});

test("processes due retries exactly once and preserves the root/source links", async () => {
  const db = setup({
    ...failedRun(),
    retryState: "scheduled",
    retryAttemptNumber: 1,
    retryNotBefore: new Date("2026-09-20T11:55:00.000Z"),
  });
  const calls = [];
  const service = createAutomationRetryService({
    admin,
    db,
    now: () => Date.parse("2026-09-20T12:00:00.000Z"),
    enqueueRetryRun: async (input) => {
      calls.push(input);
      return {id: "retry-run-1"};
    },
  });
  const result = await service.processDueRetries();
  assert.equal(result.enqueued, 1);
  assert.equal(calls[0].trigger, "retry");
  assert.equal(calls[0].retryOfRunId, "root-run");
  assert.equal(calls[0].rootRunId, "root-run");
  assert.equal(db.data.get("automationRuns/root-run").retryState, "enqueued");
  assert.equal(db.data.get("automationRuns/root-run").retryRunId, "retry-run-1");
  assert.equal((await service.processDueRetries()).checked, 0);
});

test("defers queue contention, rejects unknown outcomes, and never retries opted-out runs", async () => {
  const db = setup({
    ...failedRun(),
    retryState: "scheduled",
    retryAttemptNumber: 1,
    retryNotBefore: new Date("2026-09-20T11:55:00.000Z"),
  });
  const service = createAutomationRetryService({
    admin,
    db,
    now: () => Date.parse("2026-09-20T12:00:00.000Z"),
    enqueueRetryRun: async () => { throw Object.assign(new Error("pending"), {code: "pending_run_exists"}); },
  });
  assert.equal((await service.processDueRetries()).deferred, 1);
  assert.equal(db.data.get("automationRuns/root-run").retryState, "scheduled");
  assert.equal(retryEligibility(failedRun({unknownOutcome: true})).reason, "unknown_outcome");
  assert.equal(retryEligibility(failedRun({retryPolicy: "none"})).reason, "retry_not_opted_in");
});

console.log("automation retry service tests passed");
