"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createHash} = require("node:crypto");
const {createVmBackupRecoveryRuntimeService} = require("./vmBackupRecoveryRuntime.service");

const IMAGE = "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:" + "a".repeat(64);
const RECEIPT = {kind: "compute-engine-restore", workspaceId: "workspace", ownerUid: "owner", operationId: "operation",
  sourceGeneration: 2, targetDisk: "restore-disk", targetZone: "us-central1-a"};

test("recovery runtime refuses missing dedicated gateway configuration before creating records or compute", async () => {
  const db = memoryDb();
  let starts = 0;
  const service = createVmBackupRecoveryRuntimeService({db, compute: {start: async () => { starts++; }, inspect: async () => ({}), deleteOwnedDisk: async () => {}}, runnerImage: IMAGE});
  await assert.rejects(() => service.verify(RECEIPT, {workspaceId: "workspace", ownerUid: "owner", operationId: "operation"}),
    error => error.code === "vm_backup_recovery_gateway_unconfigured");
  assert.equal(starts, 0);
  assert.equal(db.size(), 0);
});

test("recovery runtime stages isolated lease and route records, verifies digests, then cleans exact resources", async () => {
  const db = memoryDb();
  let resources = {instance: null, disk: {id: "123", labels: labels("operation", 2), users: []}};
  const compute = {
    inspect: async () => ({instance: resources.instance, disk: resources.disk}),
    start: async () => {
      resources.instance = {privateAddress: "10.90.0.24", labels: labels("operation", 2)};
      const runtime = db.value("vmBackupRecoveryRuntimes_v2/workspace");
      const session = db.value("vmBackupRecoveryRuntimes_v2/workspace/sessions/vm-backup-" + createHash("sha256").update("operation").digest("hex").slice(0, 24));
      runtime.state = "active"; runtime.bootId = "boot"; runtime.leaseExpiresAt = 900000;
      session.state = "active"; session.bootId = "boot"; session.leaseExpiresAt = 900000;
    },
    deleteOwnedInstance: async () => { resources.instance = null; },
    deleteOwnedDisk: async () => { resources.disk = null; },
  };
  const service = createVmBackupRecoveryRuntimeService({db, compute, gatewayHost: "backup-recovery---abc-uc.a.run.app",
    runnerImage: IMAGE, now: () => 1000, sleep: async () => {}, fetchImpl: async (url) => ({ok: true, json: async () =>
      url.endsWith("/health") ? {ok: true, workspaceId: "workspace", sessionId: "vm-backup-" + createHash("sha256").update("operation").digest("hex").slice(0, 24), agentRuntime: {ready: true, state: "ready"}} :
        {ok: true, workspaceId: "workspace", sessionId: "vm-backup-" + createHash("sha256").update("operation").digest("hex").slice(0, 24),
          fileDigest: "sha256:" + "b".repeat(64), entryCount: 4, byteCount: 10}})});
  const evidence = await service.verify(RECEIPT, {workspaceId: "workspace", ownerUid: "owner", operationId: "operation"});
  assert.equal(evidence.runtimeReady, true);
  assert.equal(db.value("vmGatewayRoutes_v2/backup-recovery---abc-uc.a.run.app").enabled, true);
  const cleaned = await service.cleanup(RECEIPT, {workspaceId: "workspace", ownerUid: "owner", operationId: "operation"});
  assert.deepEqual(cleaned.instanceDeleted, true);
  assert.deepEqual(cleaned.diskDeleted, true);
  assert.equal(db.size(), 0);
});

test("recovery cleanup waits for eventual disk detachment before deleting", async () => {
  const db = memoryDb();
  let inspections = 0;
  let deleted = false;
  const compute = {
    inspect: async () => ({instance: null, disk: deleted ? null : {id: "123", labels: labels("operation", 2), users: inspections++ === 0 ? ["stale-instance"] : []}}),
    start: async () => {},
    deleteOwnedInstance: async () => {},
    deleteOwnedDisk: async () => { deleted = true; },
  };
  const service = createVmBackupRecoveryRuntimeService({db, compute, gatewayHost: "backup-recovery---abc-uc.a.run.app",
    runnerImage: IMAGE, now: () => 1000, sleep: async () => {}});
  const runtimeRef = db.collection("vmBackupRecoveryRuntimes_v2").doc("workspace");
  const sessionId = "vm-backup-" + createHash("sha256").update("operation").digest("hex").slice(0, 24);
  await runtimeRef.set({recoveryOnly: true, recoveryOperationId: "operation", ownerUid: "owner", currentSessionId: sessionId});
  await runtimeRef.collection("sessions").doc(sessionId).set({recoveryOperationId: "operation", ownerUid: "owner"});
  await db.collection("vmBackupRecoveryCredentials_v2").doc(sessionId).set({recoveryOperationId: "operation", ownerUid: "owner"});
  await db.collection("vmGatewayRoutes_v2").doc("backup-recovery---abc-uc.a.run.app").set({recoveryOnly: true, operationId: "operation", ownerUid: "owner"});
  const cleaned = await service.cleanup(RECEIPT, {workspaceId: "workspace", ownerUid: "owner", operationId: "operation"});
  assert.equal(cleaned.diskDeleted, true);
  assert.equal(deleted, true);
  assert.equal(inspections, 3);
});

function labels(operationId, generation) {
  return {"mapache-operation-id": createHash("sha256").update(operationId).digest("hex").slice(0, 63),
    "mapache-created-generation": String(generation)};
}

function memoryDb() {
  const values = new Map();
  const db = {
    collection: path => collection(path),
    runTransaction: async callback => callback({
      get: ref => ref.get(),
      create: (ref, value) => ref.set(value),
      update: (ref, value) => ref.update(value),
      delete: ref => ref.delete(),
    }),
    value: path => values.get(path),
    size: () => values.size,
  };
  return db;

  function collection(path) {
    return {doc: id => doc(`${path}/${id}`)};
  }
  function doc(path) {
    return {
      get: async () => ({exists: values.has(path), data: () => values.get(path)}),
      set: async value => values.set(path, structuredClone(value)),
      update: async updates => values.set(path, {...(values.get(path) || {}), ...structuredClone(updates)}),
      delete: async () => values.delete(path),
      collection: name => collection(`${path}/${name}`),
    };
  }
}
