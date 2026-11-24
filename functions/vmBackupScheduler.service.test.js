"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {createVmBackupSchedulerService} = require("./vmBackupScheduler.service");

const NOW = Date.parse("2026-01-02T00:00:00.000Z");

test("scheduled backup creates a durable operation and verifies a ready snapshot", async () => {
  const db = memoryDb();
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "workspace-1", ownerUid: "owner-1", generation: 2});
  db.seed("vmRuntimes_v2/workspace-1", {
    ownerUid: "owner-1", backend: "compute-engine", generation: 2, state: "active", lifecycleEnabled: true,
    runtimeProvider: descriptor, backupPolicy: {enabled: true, schedule: "daily"},
  });
  const calls = [];
  const service = createVmBackupSchedulerService({db, now: () => NOW, backup: {
    createSnapshot: async (_descriptor, options) => { calls.push(["create", options]); return {name: options.snapshotName, operation: {status: "DONE"}}; },
    inspectSnapshot: async (_descriptor, name) => { calls.push(["inspect", name]); return {name, status: "READY"}; },
    deleteSnapshot: async () => { throw new Error("unexpected_delete"); },
  }});

  const result = await service.runTick();
  assert.deepEqual(result, {checked: 1, scheduled: 1, retentionScheduled: 0, processed: 1, failed: 0, disabled: false});
  const verificationTick = await service.runTick();
  assert.equal(verificationTick.processed, 1);
  assert.equal(calls[0][0], "create");
  const operations = db.docs("vmBackupOperations_v2");
  assert.equal(operations.length, 1);
  assert.equal(operations[0].data.status, "succeeded");
  const backups = db.docs("vmBackups_v2/workspace-1/items");
  assert.equal(backups.length, 1);
  assert.equal(backups[0].data.state, "verified");
  assert.equal(backups[0].data.sourceGeneration, 2);
});

test("not-ready snapshots stay pending for a later bounded retry", async () => {
  const db = memoryDb();
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "workspace-1", ownerUid: "owner-1"});
  db.seed("vmRuntimes_v2/workspace-1", {
    ownerUid: "owner-1", backend: "compute-engine", generation: 1, state: "stopped", lifecycleEnabled: true,
    runtimeProvider: descriptor, backupPolicy: {enabled: true, schedule: "daily"},
  });
  let clock = NOW;
  const service = createVmBackupSchedulerService({db, now: () => clock, backup: {
    createSnapshot: async (_descriptor, options) => ({name: options.snapshotName, operation: {status: "PENDING"}}),
    inspectSnapshot: async () => ({status: "CREATING"}),
    deleteSnapshot: async () => { throw new Error("unexpected_delete"); },
  }});
  await service.runTick();
  await service.runTick();
  let operation = db.docs("vmBackupOperations_v2")[0].data;
  assert.equal(operation.status, "pending");
  assert.equal(operation.phase, "verify");
  assert.equal(operation.lastError, "vm_backup_snapshot_not_ready");
  assert.ok(operation.nextAttemptAtMs > NOW);
  clock = operation.nextAttemptAtMs + 1;
  const retry = await service.runTick();
  assert.equal(retry.processed, 1);
  operation = db.docs("vmBackupOperations_v2")[0].data;
  assert.equal(operation.status, "pending");
  assert.equal(operation.attempts, 3);
});

test("migration fencing prevents scheduled backup reservation", async () => {
  const db = memoryDb();
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "workspace-1", ownerUid: "owner-1"});
  db.seed("vmRuntimes_v2/workspace-1", {
    ownerUid: "owner-1", backend: "compute-engine", generation: 1, state: "active", lifecycleEnabled: true,
    runtimeProvider: descriptor, backupPolicy: {enabled: true, schedule: "daily"},
  });
  db.seed("vmMigrationFences_v2/workspace-1", {workspaceId: "workspace-1", operationId: "migration-1"});
  const service = createVmBackupSchedulerService({db, now: () => NOW, backup: {
    createSnapshot: async () => { throw new Error("must_not_call_provider"); },
    inspectSnapshot: async () => ({status: "READY"}),
    deleteSnapshot: async () => ({deleted: true}),
  }});
  const result = await service.runTick();
  assert.equal(result.scheduled, 0);
  assert.equal(db.docs("vmBackupOperations_v2").length, 0);
});

test("expired verified snapshots become ownership-bound retention operations", async () => {
  const db = memoryDb();
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "workspace-1", ownerUid: "owner-1"});
  db.seed("vmRuntimes_v2/workspace-1", {
    ownerUid: "owner-1", backend: "compute-engine", generation: 1, state: "stopped", lifecycleEnabled: true,
    runtimeProvider: descriptor, backupPolicy: {enabled: true, schedule: "daily", lastScheduledSlotMs: NOW},
  });
  db.seed("vmBackups_v2/workspace-1/items/backup-1", {
    name: "snapshot-1", workspaceId: "workspace-1", ownerUid: "owner-1", state: "verified",
    verification: {state: "verified"}, retention: {expiresAt: "2026-01-01T00:00:00.000Z"},
  });
  let deleted = 0;
  const service = createVmBackupSchedulerService({db, now: () => NOW, backup: {
    createSnapshot: async () => { throw new Error("unexpected_create"); },
    inspectSnapshot: async () => ({status: "READY"}),
    deleteSnapshot: async (_descriptor, name, options) => {
      deleted++;
      assert.equal(name, "snapshot-1");
      assert.equal(options.snapshotRecord.ownerUid, "owner-1");
      return {deleted: true, operation: {status: "DONE"}};
    },
  }});
  const result = await service.runTick();
  assert.equal(result.retentionScheduled, 1);
  assert.equal(deleted, 1);
  const operation = db.docs("vmBackupOperations_v2")[0].data;
  assert.equal(operation.status, "succeeded");
  assert.equal(db.docs("vmBackups_v2/workspace-1/items")[0].data.state, "deleted");
});

function memoryDb() {
  const values = new Map();
  const db = {
    collection: name => collection(name),
    doc: path => doc(path),
    runTransaction: async callback => callback({
      get: ref => ref.get(),
      set: (ref, value) => ref.set(value),
      update: (ref, value) => ref.update(value),
      delete: ref => ref.delete(),
    }),
    seed(path, value) { values.set(path, clone(value)); },
    docs(path) {
      const prefix = `${path}/`;
      return [...values.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map(([key, value]) => ({id: key.slice(prefix.length), data: clone(value)}));
    },
  };
  return db;

  function collection(path) {
    return {
      doc: id => doc(`${path}/${id}`),
      limit: () => ({get: async () => ({docs: db.docs(path).map(item => ({id: item.id, data: () => clone(item.data), ref: doc(`${path}/${item.id}`)}))})}),
      where: (field, operator, value) => ({
        limit: () => ({get: async () => ({docs: db.docs(path)
            .filter(item => operator === "==" ? item.data[field] === value : true)
            .map(item => ({id: item.id, data: () => clone(item.data), ref: doc(`${path}/${item.id}`)}))})}),
      }),
    };
  }

  function doc(path) {
    const id = path.split("/").pop();
    return {
      id,
      path,
      collection: name => collection(`${path}/${name}`),
      get: async () => {
        const value = values.get(path);
        return {exists: values.has(path), id, data: () => value === undefined ? undefined : clone(value)};
      },
      set: async value => values.set(path, clone(value)),
      update: async updates => values.set(path, {...(values.get(path) || {}), ...clone(updates)}),
      delete: async () => values.delete(path),
    };
  }
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
