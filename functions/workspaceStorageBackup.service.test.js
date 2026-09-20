"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  RECOVERY_POINTER_FIELD,
  SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
  createWorkspaceStorageBackupService,
} = require("./workspaceStorageBackup.service");
const {SHARED_STORAGE_REGION, deriveWorkspaceBucketName} = require("./workspaceSharedStorage.service");

const workspaceId = "workspace-1";
const ownerUid = "owner-1";
const project = {projectId: "pi-agents-cloud", projectNumber: "1234567890"};
const bucketName = deriveWorkspaceBucketName(project.projectNumber, workspaceId);

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

  async update(value) {
    this.db.data.set(this.path, {...(this.db.data.get(this.path) || {}), ...value});
  }

  async set(value) {
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

  doc(id) {
    return new Ref(this.db, `${this.path}/${id}`, id);
  }

  async get() {
    const docs = [...this.db.data.entries()]
        .filter(([path]) => path.startsWith(`${this.path}/`) && !path.slice(this.path.length + 1).includes("/"))
        .map(([path, value]) => new Snapshot(path.split("/").pop(), value));
    return {docs};
  }
}

class Snapshot {
  constructor(id, value) {
    this.id = id;
    this.exists = true;
    this.value = value;
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
    return new Collection(this, name);
  }

  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: (ref) => ref.get(),
      set: (ref, value) => writes.push({ref, value}),
      update: (ref, value) => writes.push({ref, value}),
    };
    const result = await callback(transaction);
    for (const {ref, value} of writes) this.data.set(ref.path, {...(this.data.get(ref.path) || {}), ...value});
    return result;
  }
}

class FakeFile {
  constructor(bucket, name, metadata = {}, content = Buffer.alloc(0)) {
    this.bucket = bucket;
    this.name = name;
    this.metadata = {name, ...metadata};
    this.content = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  }

  async getMetadata() {
    return [this.metadata];
  }

  async restore({generation}) {
    const source = this.bucket.softDeleted.find((file) => file.name === this.name && String(file.metadata.generation) === String(generation));
    if (!source) throw Object.assign(new Error("generation missing"), {code: 404});
    const restored = this.bucket.nextGeneration();
    this.metadata = {...source.metadata, generation: restored, timeDeleted: undefined};
    this.content = source.content;
    this.bucket.current.set(this.name, this);
    return {...this.metadata};
  }

  async copy(destination) {
    destination.metadata = {...this.metadata, name: destination.name, generation: this.bucket.nextGeneration()};
    destination.content = Buffer.from(this.content);
    this.bucket.current.set(destination.name, destination);
    return [destination.metadata];
  }

  async download() {
    return [Buffer.from(this.content)];
  }

  async save(content) {
    this.content = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content));
    this.metadata = {
      name: this.name,
      generation: this.bucket.nextGeneration(),
      size: this.content.length,
      md5Hash: crypto.createHash("md5").update(this.content).digest("base64"),
    };
    this.bucket.current.set(this.name, this);
  }
}

class FakeBucket {
  constructor(metadata, objects) {
    this.metadata = metadata;
    this.softDeleted = objects.map((object) => new FakeFile(this, object.name, object, object.content));
    this.current = new Map();
    this.generation = 9000;
  }

  nextGeneration() {
    this.generation += 1;
    return String(this.generation);
  }

  async getMetadata() {
    return [this.metadata];
  }

  async getFiles(query = {}) {
    const files = this.softDeleted.filter((file) => !query.prefix || file.name.startsWith(query.prefix));
    return [files, null];
  }

  file(name) {
    return this.current.get(name) || new FakeFile(this, name);
  }
}

function validMetadata(overrides = {}) {
  return {
    name: bucketName,
    project: project.projectId,
    labels: {
      "mapache-workspace-id": workspaceId,
      "mapache-owner-uid": ownerUid,
    },
    location: SHARED_STORAGE_REGION,
    storageClass: "STANDARD",
    hierarchicalNamespace: {enabled: true},
    iamConfiguration: {
      uniformBucketLevelAccess: {enabled: true},
      publicAccessPrevention: "enforced",
    },
    softDeletePolicy: {retentionDurationSeconds: String(SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS)},
    versioning: {enabled: false},
    ...overrides,
  };
}

function createHarness({metadata = validMetadata(), objects = [], sessions = [], workspace = {}} = {}) {
  const db = new Db();
  db.data.set(`workspaces/${workspaceId}`, {
    id: workspaceId,
    ownerUid,
    sharedStorage: {bucketName, projectId: project.projectId, projectNumber: project.projectNumber},
    ...workspace,
  });
  sessions.forEach((session, index) => db.data.set(`workspaces/${workspaceId}/sessions/${session.id || `session-${index}`}`, session));
  const bucket = new FakeBucket(metadata, objects);
  const service = createWorkspaceStorageBackupService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "SERVER"}}},
    db,
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    projectId: project.projectId,
    randomId: () => "reservation-1",
    storage: {bucket: (name) => {
      assert.equal(name, bucketName);
      return bucket;
    }},
  });
  return {bucket, db, service};
}

function object(name, generation, content, timeDeleted = "2026-09-20T10:00:00.000Z") {
  const buffer = Buffer.from(content);
  return {
    name,
    generation: String(generation),
    size: buffer.length,
    md5Hash: crypto.createHash("md5").update(buffer).digest("base64"),
    content: buffer,
    timeDeleted,
  };
}

test("diagnostics report seven-day soft delete, disabled versioning, and retained bytes", async () => {
  const harness = createHarness({objects: [object("worktree/readme.txt", 11, "known text")]});
  const diagnostic = await harness.service.checkRetention(ownerUid, workspaceId);
  assert.equal(diagnostic.compliant, true);
  assert.equal(diagnostic.policy.observedVersioningEnabled, false);
  assert.equal(diagnostic.retention.retainedBytes, 10);
  assert.equal(diagnostic.retention.recoverableUntil, "2026-09-27T10:00:00.000Z");

  const drift = createHarness({metadata: validMetadata({versioning: {enabled: true}})});
  const driftResult = await drift.service.checkRetention(ownerUid, workspaceId);
  assert.equal(driftResult.compliant, false);
  assert.equal(driftResult.errorCode, "workspace_bucket_versioning_enabled");
});

test("expired generations are omitted from recoverable inventory", async () => {
  const harness = createHarness({objects: [
    object("worktree/expired.txt", 10, "expired", "2026-09-12T10:00:00.000Z"),
    object("worktree/live.txt", 11, "live"),
  ]});
  const diagnostic = await harness.service.checkRetention(ownerUid, workspaceId);
  assert.equal(diagnostic.retention.objectCount, 1);
  assert.equal(diagnostic.retention.retainedBytes, 4);
});

test("active runners prevent a maintenance reservation", async () => {
  const harness = createHarness({sessions: [{id: "runner", status: "running"}]});
  await assert.rejects(
      harness.service.acquireMaintenanceReservation(ownerUid, workspaceId),
      (error) => error.code === "workspace_must_be_paused",
  );
});

test("lists recoverable generations and restores only the selected generation", async () => {
  const harness = createHarness({objects: [
    object("worktree/readme.txt", 11, "old"),
    object("worktree/readme.txt", 12, "new"),
  ]});
  const reservation = await harness.service.acquireMaintenanceReservation(ownerUid, workspaceId);
  const inventory = await harness.service.listRecoverableGenerations(ownerUid, workspaceId, {reservationId: reservation.reservationId});
  assert.equal(inventory.objects.length, 2);
  await assert.rejects(
      harness.service.restoreGeneration(ownerUid, workspaceId, reservation.reservationId, {
        generation: "99",
        objectPath: "worktree/readme.txt",
      }),
      (error) => error.code === "workspace_recovery_generation_not_found",
  );
  const restored = await harness.service.restoreGeneration(ownerUid, workspaceId, reservation.reservationId, {
    generation: "11",
    objectPath: "worktree/readme.txt",
    md5Hash: inventory.objects[0].md5Hash,
  });
  assert.equal(restored.sourceGeneration, "11");
  assert.notEqual(restored.restoredGeneration, "11");
  assert.equal(restored.size, 3);
  const released = await harness.service.releaseMaintenanceReservation(ownerUid, workspaceId, reservation.reservationId);
  assert.equal(released.retention.retentionSeconds, SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS);
});

test("partial tree recovery never publishes a pointer, while a verified tree publishes with billed bytes", async () => {
  const harness = createHarness({
    objects: [object("source/a.txt", 11, "alpha")],
    workspace: {sharedStorageRecovery: {state: "ready", treePrefix: "trees/current"}},
  });
  const reservation = await harness.service.acquireMaintenanceReservation(ownerUid, workspaceId);
  await assert.rejects(
      harness.service.recoverTree(ownerUid, workspaceId, reservation.reservationId, {
        version: 1,
        workspaceId,
        bucketName: "a-different-bucket",
        objects: [{objectPath: "source/a.txt", relativePath: "a.txt", generation: "11"}],
      }),
      (error) => error.code === "workspace_recovery_manifest_bucket_mismatch",
  );
  await assert.rejects(
      harness.service.recoverTree(ownerUid, workspaceId, reservation.reservationId, {
        version: 1,
        workspaceId,
        bucketName,
        objects: [{objectPath: "source/missing.txt", relativePath: "missing.txt", generation: "22"}],
      }),
      (error) => error.code === "workspace_recovery_source_unavailable",
  );
  assert.deepEqual(harness.db.data.get(`workspaces/${workspaceId}`).sharedStorageRecovery, {state: "ready", treePrefix: "trees/current"});

  const result = await harness.service.recoverTree(ownerUid, workspaceId, reservation.reservationId, {
    version: 1,
    workspaceId,
    bucketName,
    objects: [{
      md5Hash: crypto.createHash("md5").update("alpha").digest("base64"),
      objectPath: "source/a.txt",
      relativePath: "a.txt",
      generation: "11",
      size: 5,
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.pointer.objectCount, 1);
  assert.equal(result.pointer.totalBytes, 5);
  assert.equal(harness.db.data.get(`workspaces/${workspaceId}`)[RECOVERY_POINTER_FIELD].state, "ready");
  assert.equal(harness.db.data.get(`workspaces/${workspaceId}`)[RECOVERY_POINTER_FIELD].treePrefix, result.pointer.treePrefix);
});

console.log("workspace storage backup service tests passed");
