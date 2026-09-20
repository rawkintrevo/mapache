"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DELETION_OPERATION_COLLECTION,
  createWorkspaceAutomationDeletionService,
} = require("./workspaceAutomationDeletion.service");

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

  async delete() {
    this.db.data.delete(this.path);
  }

  collection(name) {
    return new Collection(this.db, `${this.path}/${name}`);
  }
}

class Collection {
  constructor(db, path, filters = []) {
    this.db = db;
    this.path = path;
    this.filters = filters;
  }

  doc(id) {
    return new Ref(this.db, `${this.path}/${id}`, id);
  }

  where(field, operator, value) {
    assert.equal(operator, "==");
    return new Collection(this.db, this.path, [...this.filters, {field, value}]);
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [...this.db.data.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .filter(([, value]) => this.filters.every(({field, value: expected}) => value[field] === expected))
        .map(([path, value]) => new Snapshot(new Ref(this.db, path, path.split("/").pop()), value));
    return {docs};
  }
}

class Snapshot {
  constructor(ref, value) {
    this.id = ref.id;
    this.ref = ref;
    this.exists = true;
    this._value = value;
  }

  data() {
    return this._value;
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
      set: (ref, value, options = {}) => options.merge ? ref.update(value) : this.data.set(ref.path, value),
      update: (ref, updates) => ref.update(updates),
    });
  }
}

function harness({deleteService = true} = {}) {
  const db = new Db();
  db.data.set("workspaces/workspace-1", {
    ownerUid: "user-1",
    name: "Workspace",
    deleted: false,
    sharedStorage: {bucketName: "mpw-workspace", storageGeneration: "generation-1", operationId: "storage-op"},
  });
  db.data.set("workspaces/workspace-1/sessions/main", {
    ownerUid: "user-1", workspaceId: "workspace-1", runtimeKind: "main", status: "running",
  });
  db.data.set("workspaces/workspace-1/sessions/auto-run-1", {
    ownerUid: "user-1", workspaceId: "workspace-1", runtimeKind: "automation", runId: "run-1", status: "running",
  });
  db.data.set("automationRuns/run-1", {
    ownerUid: "user-1", workspaceId: "workspace-1", automationId: "automation-1", sessionId: "auto-run-1",
    status: "running", cleanupState: "pending",
  });
  db.data.set("workspaces/workspace-1/automations/automation-1", {pendingRunId: null});
  db.data.set("workspaces/workspace-1/automations/automation-1/audit/audit-1", {changedFields: ["name"]});
  db.data.set("workspaces/workspace-1/automationAudit/audit-1", {changedFields: ["automationMaxConcurrency"]});
  db.data.set("users/user-1/sessionUsage/usage-1", {seconds: 4});
  const calls = [];
  const service = createWorkspaceAutomationDeletionService({
    admin,
    automationCleanupService: {
      cleanupAutomationRun: async (runId) => {
        calls.push(["cleanup", runId]);
        return {cleaned: true};
      },
    },
    db,
    deleteSessionForWorkspace: async (ref, session) => {
      calls.push(["main", ref.id]);
      if (!deleteService) throw Object.assign(new Error("service deletion failed"), {code: "cloud_run_delete_failed"});
      await ref.delete();
    },
    deleteSessionService: async (ref, session) => {
      calls.push(["service", ref.id]);
      return {serviceAbsent: deleteService};
    },
    deleteWorkspaceSharedStorage: async (uid, workspaceId) => {
      calls.push(["bucket", workspaceId]);
      return {
        deleted: true,
        bucketDeleted: true,
        bucketName: "mpw-workspace",
        retainedRecovery: {
          recoverableUntil: "2026-09-27T00:00:00.000Z",
          retainedBytes: 1234,
        },
      };
    },
    sessionCollection: (workspaceId) => db.collection(`workspaces/${workspaceId}/sessions`),
  });
  return {calls, db, service};
}

test("workspace deletion tombstones first, waits for service absence, and preserves usage ledger", async () => {
  const {calls, db, service} = harness();
  const operation = await service.deleteWorkspace("user-1", "workspace-1");
  assert.equal(operation.state, "complete");
  assert.equal(operation.recoverableBytes, 1234);
  assert.deepEqual(calls.map(([kind]) => kind), ["cleanup", "main", "bucket"]);
  assert.equal(db.data.get("workspaces/workspace-1").lifecycle, "deleted");
  assert.equal(db.data.has("automationRuns/run-1"), false);
  assert.equal(db.data.has("workspaces/workspace-1/automations/automation-1/audit/audit-1"), false);
  assert.equal(db.data.has("users/user-1/sessionUsage/usage-1"), true);
  assert.equal(db.data.has(`${DELETION_OPERATION_COLLECTION}/workspace-1`), true);
});

test("failed service deletion blocks bucket deletion and leaves a resumable tombstone", async () => {
  const {calls, db, service} = harness({deleteService: false});
  await assert.rejects(() => service.deleteWorkspace("user-1", "workspace-1"), /workspace_compute_cleanup_failed/);
  assert.equal(calls.some(([kind]) => kind === "bucket"), false);
  assert.equal(db.data.get("workspaces/workspace-1").deleted, true);
  assert.equal(db.data.get(`${DELETION_OPERATION_COLLECTION}/workspace-1`).state, "blocked");
});

console.log("workspace automation deletion service tests passed");
