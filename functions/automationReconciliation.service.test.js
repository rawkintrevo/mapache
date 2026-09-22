"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {cloudRunServiceLabels} = require("./cloudRun.service");
const {createAutomationReconciliationService} = require("./automationReconciliation.service");

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

function makeRun(overrides = {}) {
  return {
    runId: "run-1",
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    sessionId: "auto-run-1",
    status: "running",
    cleanupState: "pending",
    executionHeartbeatAt: "2026-09-20T09:55:00.000Z",
    ...overrides,
  };
}

function harness(runs = [makeRun()], overrides = {}) {
  const db = new Db();
  runs.forEach((run) => db.data.set(`automationRuns/${run.runId}`, run));
  db.data.set("workspaces/workspace-1/sessions/auto-run-1", {
    id: "auto-run-1",
    runtimeKind: "automation",
    automationRunId: "run-1",
    workspaceId: "workspace-1",
    ownerUid: "user-1",
    serviceUrl: "https://runner.example",
    shutdownToken: "shutdown",
    ...overrides.session,
  });
  const calls = [];
  const service = createAutomationReconciliationService({
    admin,
    cleanupAutomationRun: async (runId) => calls.push({action: "cleanup", runId}),
    db,
    getCloudRunService: overrides.getCloudRunService || (async () => ({
      labels: cloudRunServiceLabels({
        automationRunId: "run-1",
        ownerUid: "user-1",
        runtimeKind: "automation",
        workspaceId: "workspace-1",
      }),
    })),
    healthProbe: overrides.healthProbe || (async () => ({ok: true})),
    listCloudRunServices: overrides.listCloudRunServices || (async () => []),
    listRuns: async () => runs,
    now: () => Date.parse("2026-09-20T10:00:00.000Z"),
    provisionAutomationRun: async (runId) => calls.push({action: "provision", runId}),
    sessionCollection: (workspaceId) => db.collection(`workspaces/${workspaceId}/sessions`),
    deleteCloudRunService: async (serviceName) => calls.push({action: "delete", serviceName}),
    ...overrides,
  });
  return {calls, db, service};
}

test("healthy stale runners are retained without replaying work", async () => {
  const {calls, db, service} = harness();
  const result = await service.reconcile();
  assert.equal(result.healthy, 1);
  assert.equal(calls.length, 0);
  assert.equal(db.data.get("automationRuns/run-1").status, "running");
  assert.equal(db.data.get("automationRuns/run-1").reconciliationLastAction, "healthy");
});

test("unreachable runners are interrupted only after the Cloud Run lookup succeeds", async () => {
  const {calls, db, service} = harness([makeRun()], {
    healthProbe: async () => { throw Object.assign(new Error("gone"), {code: "runner_unavailable"}); },
    getCloudRunService: async () => ({
      labels: cloudRunServiceLabels({
        automationRunId: "run-1",
        ownerUid: "user-1",
        runtimeKind: "automation",
        workspaceId: "workspace-1",
      }),
    }),
  });
  const result = await service.reconcile();
  assert.equal(result.interrupted, 1);
  assert.deepEqual(calls, [{action: "cleanup", runId: "run-1"}]);
  assert.equal(db.data.get("automationRuns/run-1").desiredOutcome, "interrupted");
  assert.equal(db.data.get("automationRuns/run-1").status, "stopping");
});

test("an ambiguous Cloud Run lookup retains the reservation", async () => {
  const {calls, db, service} = harness([makeRun()], {
    healthProbe: async () => ({ok: false}),
    getCloudRunService: async () => { throw Object.assign(new Error("timeout"), {code: "cloud_run_timeout"}); },
  });
  const result = await service.reconcile();
  assert.equal(result.retained, 1);
  assert.equal(calls.length, 0);
  assert.equal(db.data.get("automationRuns/run-1").status, "running");
});

test("reconciliation resumes provisioning and deletes only rechecked labeled orphans", async () => {
  const liveLabels = cloudRunServiceLabels({
    automationRunId: "run-1",
    ownerUid: "user-1",
    runtimeKind: "automation",
    workspaceId: "workspace-1",
  });
  const orphanLabels = cloudRunServiceLabels({
    automationRunId: "orphan-run",
    ownerUid: "user-1",
    runtimeKind: "automation",
    workspaceId: "workspace-1",
  });
  const runs = [makeRun(), makeRun({runId: "run-2", status: "provisioning", executionHeartbeatAt: "2026-09-20T10:00:00.000Z"})];
  const {calls, service} = harness(runs, {
    listCloudRunServices: async () => [
      {name: "projects/p/locations/us-central1/services/live", labels: liveLabels},
      {name: "projects/p/locations/us-central1/services/orphan", labels: orphanLabels},
      {name: "projects/p/locations/us-central1/services/main", labels: {"mapache-runtime-kind": "main"}},
    ],
    getCloudRunService: async (name) => name.endsWith("/orphan") ? {name, labels: orphanLabels} : {name, labels: liveLabels},
  });
  await service.reconcile();
  assert.equal(calls.some((call) => call.action === "provision" && call.runId === "run-2"), true);
  assert.equal(calls.some((call) => call.action === "delete" && call.serviceName.endsWith("/orphan")), true);
  assert.equal(calls.some((call) => call.action === "delete" && call.serviceName.endsWith("/main")), false);
});

test("the production reconciliation query has a matching checked-in Firestore index", async () => {
  const fields = [];
  const query = {
    where(field, operator) {
      assert.equal(operator, "in");
      fields.push({fieldPath: field, order: "ASCENDING"});
      return this;
    },
    orderBy(field, direction) {
      fields.push({fieldPath: field, order: direction === "asc" ? "ASCENDING" : "DESCENDING"});
      return this;
    },
    limit() { return this; },
    async get() { return {docs: []}; },
  };
  const {service} = harness([], {
    listRuns: undefined,
    db: {collection: (name) => {
      assert.equal(name, "automationRuns");
      return query;
    }},
  });
  await service.reconcile();
  const indexSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "../firestore.indexes.json"), "utf8");
  const {indexes} = JSON.parse(indexSource.replace(/^\s*\/\/.*$/gm, ""));
  assert.ok(indexes.some((index) => index.collectionGroup === "automationRuns" &&
    index.queryScope === "COLLECTION" &&
    JSON.stringify(index.fields.filter((field) => field.fieldPath !== "__name__")) === JSON.stringify(fields)),
  "deployable index must match the actual reconciliation query");
});

test("orphan inventory uses the regional Cloud Run v2 request contract and skips main services", async () => {
  const requests = [];
  const client = {
    getProjectId: async () => "test-project",
    request: async ({url, method}) => {
      const parsed = new URL(url);
      requests.push(parsed);
      assert.equal(method, "GET");
      assert.ok(parsed.pathname.endsWith(`/locations/${require("./backendConfig").DEFAULT_REGION}/services`));
      assert.equal(parsed.searchParams.has("filter"), false);
      assert.equal(parsed.searchParams.get("pageSize"), "50");
      return {data: requests.length === 1 ? {
        services: [{name: "main-service", labels: {"mapache-runtime-kind": "main"}}],
        nextPageToken: "next-page",
      } : {services: []}};
    },
  };
  const {calls, service} = harness([], {
    auth: {getClient: async () => client},
    listCloudRunServices: undefined,
  });
  const result = await service.reconcile();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get("pageToken"), "next-page");
  assert.equal(result.errors, 0);
  assert.equal(result.orphanServices, 0);
  assert.deepEqual(calls, []);
});

console.log("automation reconciliation service tests passed");
