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

function setup(sessions = {}) {
  const db = new Db();
  db.data.set("workspaces/workspace-1", {
    ownerUid: "user-1",
    bucket: "legacy-bucket",
    storagePrefix: "workspaces/user-1/workspace-1",
    sharedStorageState: "legacy",
  });
  for (const [id, value] of Object.entries(sessions)) {
    db.data.set(`workspaces/workspace-1/sessions/${id}`, value);
  }
  const service = createWorkspaceStorageMigrationService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "SERVER"}}},
    db,
    sharedStorageService: {
      ensureWorkspaceSharedStorage: async () => ({
        bucketName: "mpw-123-workspace",
        projectId: "pi-agents-cloud",
        projectNumber: "123",
      }),
    },
    verifyReadyGeneration: async () => {},
  });
  return {db, service};
}

test("reserves a paused workspace idempotently and cuts over only after verification", async () => {
  const {db, service} = setup({main: {status: "stopped"}});
  const prepared = await service.prepare("user-1", "workspace-1");
  assert.equal(prepared.accepted, true);
  assert.equal(prepared.state, "migrating");
  assert.equal(prepared.operationId.length > 0, true);
  const repeated = await service.prepare("user-1", "workspace-1");
  assert.equal(repeated.idempotent, true);

  const completed = await service.complete("user-1", "workspace-1", {
    operationId: prepared.operationId,
    bucketName: "mpw-123-workspace",
    storageGeneration: prepared.generation,
    readyMarkerObjectPath: `trees/${prepared.operationId}/.mapache-internal/workspace-ready.json`,
    readyMarker: ".mapache-internal/workspace-ready.json",
    treePrefix: `trees/${prepared.operationId}`,
  });
  assert.equal(completed.state, "ready");
  assert.equal(db.data.get("workspaces/workspace-1").sharedStorage.storageGeneration, prepared.generation);
  assert.equal(db.data.get("workspaces/workspace-1").sharedStorageState, "ready");
  assert.equal(db.data.get("workspaces/workspace-1").bucket, "legacy-bucket");
});

test("active services block migration and preserve the legacy pointer on failure", async () => {
  const {db, service} = setup({main: {status: "running"}});
  await assert.rejects(() => service.prepare("user-1", "workspace-1"), /workspace_must_be_paused/);

  const ready = setup({main: {status: "stopped"}});
  const prepared = await ready.service.prepare("user-1", "workspace-1");
  const failed = await ready.service.fail("user-1", "workspace-1", {
    operationId: prepared.operationId,
    errorCode: "unsupported_file",
  });
  assert.equal(failed.state, "error");
  assert.equal(ready.db.data.get("workspaces/workspace-1").bucket, "legacy-bucket");
  assert.equal(ready.db.data.get("workspaces/workspace-1").sharedStorage, undefined);
});
