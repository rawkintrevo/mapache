"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createWorkspaceStorageMigrationService,
} = require("./workspaceStorageMigration.service");

class Ref {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }

  async get() {
    const value = this.db.data.get(this.path);
    return {exists: value !== undefined, id: this.id, data: () => value};
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
    const writes = [];
    const transaction = {
      get: (ref) => {
        if (ref instanceof Collection) {
          const docs = [...this.data.entries()]
              .filter(([path]) => path.startsWith(`${ref.path}/`) && !path.slice(ref.path.length + 1).includes("/"))
              .map(([path, value]) => new Snapshot(new Ref(this, path, path.split("/").pop()), value));
          return Promise.resolve({docs});
        }
        return ref.get();
      },
      update: (ref, value) => writes.push({ref, value}),
    };
    const result = await callback(transaction);
    for (const {ref, value} of writes) this.data.set(ref.path, {...(this.data.get(ref.path) || {}), ...value});
    return result;
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

function setup(sessions = {}, workspaceOverrides = {}, beforeValidationReturns) {
  const db = new Db();
  const workspace = {
    ownerUid: "user-1",
    bucket: "legacy-bucket",
    storagePrefix: "workspaces/user-1/workspace-1",
    sharedStorageState: "legacy",
    ...workspaceOverrides,
  };
  db.data.set("workspaces/workspace-1", workspace);
  for (const [id, value] of Object.entries(sessions)) {
    db.data.set(`workspaces/workspace-1/sessions/${id}`, value);
  }
  let ensureCalls = 0;
  let validateCalls = 0;
  const service = createWorkspaceStorageMigrationService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "SERVER"}}},
    db,
    sharedStorageService: {
      ensureWorkspaceSharedStorage: async () => {
        ensureCalls++;
        return {
          bucketName: "mpw-123-workspace",
          projectId: "pi-agents-cloud",
          projectNumber: "123",
        };
      },
      validateExistingWorkspaceSharedStorage: async () => {
        validateCalls++;
        await beforeValidationReturns?.(db);
        return {
          ...workspace.sharedStorage,
          state: "ready",
          errorCode: null,
        };
      },
    },
    verifyReadyGeneration: async () => {},
  });
  return {db, service, getEnsureCalls: () => ensureCalls, getValidateCalls: () => validateCalls};
}

test("requires an existing shared-storage descriptor and never starts bucket preparation", async () => {
  const {db, service} = setup({main: {status: "stopped"}});
  await assert.rejects(
      service.prepare("user-1", "workspace-1"),
      /workspace_shared_storage_required/,
  );
  assert.equal(db.data.get("workspaces/workspace-1").sharedStorageState, "legacy");
});

test("a VM fence blocks legacy descriptor reconciliation, including a stale provider response", async () => {
  const fencePath = "vmMigrationFences_v2/workspace-1";
  const workspacePath = "workspaces/workspace-1";
  const sharedStorage = {bucketName: "mpw-123-existing", storageGeneration: "existing-generation"};
  for (const providerFailed of [false, true]) {
    const {db, service, getValidateCalls} = setup({}, {sharedStorage}, async currentDb => {
      currentDb.data.set(fencePath, {});
      if (providerFailed) throw Object.assign(new Error("workspace_bucket_iam_failed"), {publicMessage: "workspace_bucket_iam_failed"});
    });
    const original = db.data.get(workspacePath);
    await assert.rejects(service.prepare("user-1", "workspace-1"),
        {publicMessage: providerFailed ? "workspace_bucket_iam_failed" : "workspace_vm_migration_active"});
    assert.deepEqual(db.data.get(workspacePath), original);
    await assert.rejects(service.prepare("user-1", "workspace-1"), {publicMessage: "workspace_vm_migration_active"});
    await assert.rejects(service.complete("user-1", "workspace-1", {
      operationId: "stale", bucketName: sharedStorage.bucketName, storageGeneration: sharedStorage.storageGeneration,
      readyMarkerObjectPath: "trees/existing-generation/ready",
    }), {publicMessage: "workspace_vm_migration_active"});
    await assert.rejects(service.fail("user-1", "workspace-1", {operationId: "stale"}),
        {publicMessage: "workspace_vm_migration_active"});
    assert.equal(getValidateCalls(), 1);
    assert.deepEqual(db.data.get(workspacePath), original);
  }
});

test("active services block migration and preserve the legacy pointer on failure", async () => {
  const {db, service} = setup({main: {status: "running"}});
  await assert.rejects(() => service.prepare("user-1", "workspace-1"), /workspace_must_be_paused/);

  const ready = setup({main: {status: "stopped"}}, {
    sharedStorageMigration: {
      operationId: "existing-operation",
      generation: "existing-generation",
      state: "migrating",
      progress: {phase: "awaiting_import", completed: false},
    },
  });
  const failed = await ready.service.fail("user-1", "workspace-1", {
    operationId: "existing-operation",
    errorCode: "unsupported_file",
  });
  assert.equal(failed.state, "error");
  assert.equal(ready.db.data.get("workspaces/workspace-1").bucket, "legacy-bucket");
  assert.equal(ready.db.data.get("workspaces/workspace-1").sharedStorage, undefined);
});

test("reuses and validates an already-prepared workspace descriptor", async () => {
  const existingDescriptor = {
    state: "ready",
    bucketName: "mpw-123-existing",
    projectId: "pi-agents-cloud",
    projectNumber: "123",
    operationId: "existing-operation",
    storageGeneration: "existing-generation",
    treePrefix: "trees/existing-generation",
  };
  const {db, service, getEnsureCalls, getValidateCalls} = setup({main: {status: "stopped"}}, {
    sharedStorageState: "legacy",
    sharedStorage: existingDescriptor,
  });

  const result = await service.prepare("user-1", "workspace-1");

  assert.equal(result.reused, true);
  assert.equal(result.state, "ready");
  assert.equal(result.generation, "existing-generation");
  assert.equal(getValidateCalls(), 1);
  assert.equal(getEnsureCalls(), 0, "an already-prepared workspace must not start a migration or create a bucket");
  assert.equal(db.data.get("workspaces/workspace-1").sharedStorage.storageGeneration, "existing-generation");
  assert.equal(db.data.get("workspaces/workspace-1").sharedStorage.treePrefix, "trees/existing-generation");
  assert.equal(db.data.get("workspaces/workspace-1").sharedStorageState, "ready");
  assert.equal(db.data.get("workspaces/workspace-1").workspaceStorageMode, "shared-gcsfuse-v1");
});
