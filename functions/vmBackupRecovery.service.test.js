"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {createBackupRecord, createRestoreReceipt, markBackupVerified} = require("./vmBackupPolicy.helpers");
const {createVmBackupRecoveryService} = require("./vmBackupRecovery.service");

const NOW = Date.parse("2026-01-02T00:00:00.000Z");

test("recovery controller requires a cleanup-capable runtime adapter", () => {
  assert.throws(() => createVmBackupRecoveryService({db: memoryDb(), backup: {}, restoreRuntime: {verify: async () => ({})}}),
    /vm_backup_recovery_dependencies_required/);
});

test("restore controller records fresh-disk verification and RPO/RTO evidence", async () => {
  const db = memoryDb();
  seedRuntime(db);
  db.seed("vmBackups_v2/workspace-1/items/backup-1", verifiedBackup());
  let clock = NOW;
  const restoreCalls = [];
  const service = createVmBackupRecoveryService({db, now: () => clock, backup: {
    restoreSnapshot: async (descriptor, options) => {
      restoreCalls.push({descriptor, options});
      return createRestoreReceipt({workspaceId: "workspace-1", ownerUid: "owner-1", operationId: options.operationId,
        sourceSnapshot: "snapshot-1", sourceGeneration: 1, targetDisk: options.diskName, targetZone: "us-central1-a",
        targetDiskSizeGb: 64, createdAt: new Date(clock).toISOString()});
    },
  }, restoreRuntime: {
    verify: async () => ({runtimeReady: true, fileDigest: "sha256:files", runtimeStateDigest: "sha256:runtime",
      diskId: "123", startupStageTimingsMs: {mount: 120, health: 340}}),
    cleanup: async () => ({instanceDeleted: true, diskDeleted: true}),
  }});
  const requested = await service.requestRestore({workspaceId: "workspace-1", ownerUid: "owner-1", requestId: "restore-request-1",
    backupId: "backup-1", expectedGeneration: 1});
  assert.equal(requested.status, "pending");
  await service.runTick();
  clock += 500;
  const second = await service.runTick();
  assert.equal(second.processed, 1);
  assert.equal(restoreCalls.length, 1);
  const operation = db.docs("vmBackupRecoveryOperations_v2")[0].data;
  assert.equal(operation.status, "succeeded");
  assert.equal(operation.restoreReceipt.verification.state, "verified");
  const report = db.docs("vmBackupRecoveryReports_v2/workspace-1/reports")[0].data;
  assert.equal(report.passed, true);
  assert.equal(report.rpoWithinTarget, true);
  assert.equal(report.rtoWithinTarget, true);
  assert.equal(report.fileDigest, "sha256:files");
  assert.deepEqual(report.startupStageTimingsMs, {mount: 120, health: 340});
});

test("restore verification fails closed on a file digest mismatch", async () => {
  const db = memoryDb();
  seedRuntime(db);
  db.seed("vmBackups_v2/workspace-1/items/backup-1", verifiedBackup({verification: {
    state: "verified", verifiedAt: "2026-01-01T00:01:00.000Z", fileDigest: "sha256:expected",
  }}));
  let cleanupCalls = 0;
  const service = createVmBackupRecoveryService({db, now: () => NOW, backup: {
    restoreSnapshot: async (_descriptor, options) => createRestoreReceipt({workspaceId: "workspace-1", ownerUid: "owner-1",
      operationId: options.operationId, sourceSnapshot: "snapshot-1", sourceGeneration: 1, targetDisk: options.diskName,
      targetZone: "us-central1-a", targetDiskSizeGb: 64, createdAt: new Date(NOW).toISOString()}),
  }, restoreRuntime: {
    verify: async () => ({runtimeReady: true, fileDigest: "sha256:wrong", runtimeStateDigest: "sha256:runtime"}),
    cleanup: async () => { cleanupCalls++; return {instanceDeleted: true, diskDeleted: true, timingsMs: {delete: 40}}; },
  }});
  await service.requestRestore({workspaceId: "workspace-1", ownerUid: "owner-1", requestId: "restore-request-2", backupId: "backup-1"});
  await service.runTick();
  await service.runTick();
  const operation = db.docs("vmBackupRecoveryOperations_v2")[0].data;
  assert.equal(operation.status, "failed");
  assert.equal(operation.lastError, "vm_restore_file_digest_mismatch");
  assert.deepEqual(operation.cleanup, {state: "complete", instanceDeleted: true, diskDeleted: true, timingsMs: {delete: 40}});
  assert.equal(cleanupCalls, 1);
  assert.equal(db.docs("vmBackupRecoveryReports_v2/workspace-1/reports")[0].data.passed, false);
});

test("restore verification fails closed when the backup has no source digests", async () => {
  const db = memoryDb();
  seedRuntime(db);
  db.seed("vmBackups_v2/workspace-1/items/backup-1", verifiedBackup({}, {fileDigest: null, runtimeStateDigest: null}));
  let cleanupCalls = 0;
  const service = createVmBackupRecoveryService({db, now: () => NOW, backup: {
    restoreSnapshot: async (_descriptor, options) => createRestoreReceipt({workspaceId: "workspace-1", ownerUid: "owner-1",
      operationId: options.operationId, sourceSnapshot: "snapshot-1", sourceGeneration: 1, targetDisk: options.diskName,
      targetZone: "us-central1-a", targetDiskSizeGb: 64, createdAt: new Date(NOW).toISOString()}),
  }, restoreRuntime: {
    verify: async () => ({runtimeReady: true, fileDigest: "sha256:target-files", runtimeStateDigest: "sha256:target-runtime"}),
    cleanup: async () => { cleanupCalls++; return {instanceDeleted: true, diskDeleted: true}; },
  }});
  await service.requestRestore({workspaceId: "workspace-1", ownerUid: "owner-1", requestId: "restore-request-undigested", backupId: "backup-1"});
  await service.runTick();
  await service.runTick();
  const operation = db.docs("vmBackupRecoveryOperations_v2")[0].data;
  assert.equal(operation.status, "failed");
  assert.equal(operation.lastError, "vm_restore_source_file_digest_missing");
  assert.equal(operation.verification.sourceFileDigestCompared, false);
  assert.equal(operation.verification.sourceRuntimeStateDigestCompared, false);
  assert.equal(cleanupCalls, 1);
});

test("failed recovery cleanup stays pending until exact resources are confirmed gone", async () => {
  const db = memoryDb();
  seedRuntime(db);
  db.seed("vmBackups_v2/workspace-1/items/backup-1", verifiedBackup({verification: {
    state: "verified", verifiedAt: "2026-01-01T00:01:00.000Z", fileDigest: "sha256:expected",
  }}));
  let clock = NOW;
  let cleanupAttempts = 0;
  const service = createVmBackupRecoveryService({db, now: () => clock, backup: {
    restoreSnapshot: async (_descriptor, options) => createRestoreReceipt({workspaceId: "workspace-1", ownerUid: "owner-1",
      operationId: options.operationId, sourceSnapshot: "snapshot-1", sourceGeneration: 1, targetDisk: options.diskName,
      targetZone: "us-central1-a", targetDiskSizeGb: 64, createdAt: new Date(NOW).toISOString()}),
  }, restoreRuntime: {
    verify: async () => ({runtimeReady: true, fileDigest: "sha256:wrong", runtimeStateDigest: "sha256:runtime"}),
    cleanup: async () => {
      cleanupAttempts++;
      if (cleanupAttempts === 1) { const error = new Error("delete_pending"); error.code = "vm_restore_cleanup_pending"; throw error; }
      return {instanceDeleted: true, diskDeleted: true};
    },
  }});
  await service.requestRestore({workspaceId: "workspace-1", ownerUid: "owner-1", requestId: "restore-request-cleanup", backupId: "backup-1"});
  await service.runTick();
  await service.runTick();
  let operation = db.docs("vmBackupRecoveryOperations_v2")[0].data;
  assert.equal(operation.phase, "cleanup");
  assert.equal(operation.status, "pending");
  assert.equal(operation.lastError, "vm_restore_cleanup_pending");
  clock = operation.nextAttemptAtMs + 1;
  await service.runTick();
  operation = db.docs("vmBackupRecoveryOperations_v2")[0].data;
  assert.equal(operation.status, "failed");
  assert.deepEqual(operation.cleanup, {state: "complete", instanceDeleted: true, diskDeleted: true, timingsMs: {}});
  assert.equal(cleanupAttempts, 2);
});

test("restore reservation refuses foreign backups and migration-fenced workspaces", async () => {
  const db = memoryDb();
  seedRuntime(db);
  db.seed("vmBackups_v2/workspace-1/items/foreign", verifiedBackup({ownerUid: "other-owner"}));
  const service = createVmBackupRecoveryService({db, now: () => NOW, backup: {restoreSnapshot: async () => { throw new Error("not_called"); }},
    restoreRuntime: {verify: async () => ({}), cleanup: async () => ({instanceDeleted: true, diskDeleted: true})}});
  await assert.rejects(() => service.requestRestore({workspaceId: "workspace-1", ownerUid: "owner-1", requestId: "restore-request-3", backupId: "foreign"}),
    error => error.code === "vm_restore_backup_not_verified");
  db.seed("vmBackups_v2/workspace-1/items/backup-1", verifiedBackup());
  db.seed("vmMigrationFences_v2/workspace-1", {operationId: "migration-1"});
  await assert.rejects(() => service.requestRestore({workspaceId: "workspace-1", ownerUid: "owner-1", requestId: "restore-request-4", backupId: "backup-1"}),
    error => error.code === "vm_restore_migration_in_progress");
  assert.equal(db.docs("vmBackupRecoveryOperations_v2").length, 0);
});

test("transient restore verification errors retain a bounded retry", async () => {
  const db = memoryDb();
  seedRuntime(db);
  db.seed("vmBackups_v2/workspace-1/items/backup-1", verifiedBackup());
  let clock = NOW;
  let attempts = 0;
  const service = createVmBackupRecoveryService({db, now: () => clock, backup: {
    restoreSnapshot: async (_descriptor, options) => createRestoreReceipt({workspaceId: "workspace-1", ownerUid: "owner-1",
      operationId: options.operationId, sourceSnapshot: "snapshot-1", sourceGeneration: 1, targetDisk: options.diskName,
      targetZone: "us-central1-a", targetDiskSizeGb: 64, createdAt: new Date(NOW).toISOString()}),
  }, restoreRuntime: {verify: async () => {
    attempts++;
    if (attempts === 1) { const error = new Error("runner_not_ready"); error.code = "vm_restore_runtime_not_ready"; throw error; }
    return {runtimeReady: true, fileDigest: "sha256:files", runtimeStateDigest: "sha256:runtime"};
  }, cleanup: async () => ({instanceDeleted: true, diskDeleted: true})}});
  await service.requestRestore({workspaceId: "workspace-1", ownerUid: "owner-1", requestId: "restore-request-5", backupId: "backup-1"});
  await service.runTick();
  await service.runTick();
  let operation = db.docs("vmBackupRecoveryOperations_v2")[0].data;
  assert.equal(operation.status, "pending");
  assert.equal(operation.lastError, "vm_restore_runtime_not_ready");
  clock = operation.nextAttemptAtMs + 1;
  await service.runTick();
  operation = db.docs("vmBackupRecoveryOperations_v2")[0].data;
  assert.equal(operation.status, "succeeded");
  assert.equal(attempts, 2);
});

function seedRuntime(db) {
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "workspace-1", ownerUid: "owner-1"});
  db.seed("vmRuntimes_v2/workspace-1", {ownerUid: "owner-1", backend: "compute-engine", generation: 1,
    state: "stopped", lifecycleEnabled: true, runtimeProvider: descriptor, backupPolicy: {enabled: true, schedule: "daily"}});
}

function verifiedBackup(overrides = {}, evidenceOverrides = {}) {
  const record = createBackupRecord({workspaceId: "workspace-1", ownerUid: "owner-1", operationId: "backup-operation-1",
    sourceDisk: "mapache-disk-1", sourceGeneration: 1, capturedAt: "2026-01-01T23:50:00.000Z"});
  return {name: "snapshot-1", ...markBackupVerified({...record, ...overrides}, {
    workspaceId: overrides.workspaceId || "workspace-1", ownerUid: overrides.ownerUid || "owner-1",
    operationId: "backup-operation-1", verifiedAt: "2026-01-01T23:55:00.000Z", fileDigest: "sha256:files",
    runtimeStateDigest: "sha256:runtime", ...evidenceOverrides,
  })};
}

function memoryDb() {
  const values = new Map();
  const db = {
    collection: path => collection(path),
    runTransaction: async callback => callback({get: ref => ref.get(), set: (ref, value) => ref.set(value), update: (ref, value) => ref.update(value)}),
    seed(path, value) { values.set(path, clone(value)); },
    docs(path) {
      const prefix = `${path}/`;
      return [...values.entries()].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map(([key, value]) => ({id: key.slice(prefix.length), data: clone(value)}));
    },
  };
  return db;

  function collection(path) {
    return {
      doc: id => doc(`${path}/${id}`),
      limit: () => ({get: async () => ({docs: db.docs(path).map(item => ({id: item.id, data: () => clone(item.data), ref: doc(`${path}/${item.id}`)}))})}),
      where: (field, operator, value) => ({limit: () => ({get: async () => ({docs: db.docs(path)
          .filter(item => operator === "==" ? item.data[field] === value : true)
          .map(item => ({id: item.id, data: () => clone(item.data), ref: doc(`${path}/${item.id}`)}))})})}),
    };
  }

  function doc(path) {
    const id = path.split("/").pop();
    return {
      id,
      get: async () => { const value = values.get(path); return {exists: values.has(path), id, data: () => value === undefined ? undefined : clone(value)}; },
      collection: name => collection(`${path}/${name}`),
      set: async value => values.set(path, clone(value)),
      update: async updates => values.set(path, {...(values.get(path) || {}), ...clone(updates)}),
    };
  }
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
