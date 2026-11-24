"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createComputeEngineBackupService} = require("./computeEngineBackup.service");
const {createBackupRecord, markBackupVerified} = require("./vmBackupPolicy.helpers");
const {createRuntimeDescriptor, COMPUTE_ENGINE_BACKEND} = require("./runtimeProvider.helpers");

const descriptor = createRuntimeDescriptor({backend: COMPUTE_ENGINE_BACKEND, workspaceId: "workspace-1", ownerUid: "owner-1", zone: "us-central1-a"});

test("backup service labels snapshots and reports known storage cost", async () => {
  const calls = [];
  const service = createComputeEngineBackupService({
    request: async (request) => {
      calls.push(request);
      if (request.method === "GET") return {data: {name: "snapshot-1", diskSizeGb: "64", selfLink: "snapshot-link", labels: {"mapache-owner-uid": "owner-1", "mapache-workspace-id": "workspace-1", "mapache-runtime-provider": "compute-engine"}}};
      return {data: {status: "DONE"}};
    },
  });
  const result = await service.createSnapshot(descriptor, {snapshotName: "snapshot-1", operationId: "op-1"});
  assert.equal(result.name, "snapshot-1");
  assert.equal(calls[0].data.labels["mapache-workspace-id"], "workspace-1");
  assert.equal(calls[0].data.labels["mapache-consistency"], "crash-consistent");
  assert.equal(calls[0].data.labels["mapache-source-generation"], "1");
  assert.equal(result.state, "creating");
  assert.equal(result.recoverablePoint.sourceDisk, descriptor.dataDiskName);
  assert.deepEqual(service.costSummary({retainedGiB: 64, changedSnapshotGiB: 8}), {
    retainedStorageMonthlyUsd: 6.4,
    snapshotStorageMonthlyUsd: 0.52,
    totalKnownMonthlyUsd: 6.92,
    ratesAreEstimates: true,
  });
});

test("backup restore creates a fresh owned disk receipt and rejects undersized targets", async () => {
  const calls = [];
  const service = createComputeEngineBackupService({
    request: async (request) => {
      calls.push(request);
      if (request.method === "GET") return {data: {name: "snapshot-1", diskSizeGb: "64", selfLink: "snapshot-link", labels: {
        "mapache-owner-uid": "owner-1", "mapache-workspace-id": "workspace-1", "mapache-runtime-provider": "compute-engine",
        "mapache-source-generation": "2", "mapache-consistency": "crash-consistent", "mapache-retention-days": "14",
      }}};
      return {data: {status: "PENDING"}};
    },
  });
  await assert.rejects(() => service.restoreSnapshot(descriptor, {snapshotName: "snapshot-1", operationId: "restore-1", diskName: descriptor.dataDiskName}),
    error => error.code === "vm_backup_restore_target_must_be_fresh");
  await assert.rejects(() => service.restoreSnapshot(descriptor, {snapshotName: "snapshot-1", operationId: "restore-1", sizeGb: 32}),
    error => error.code === "vm_backup_restore_size_invalid");
  const restored = await service.restoreSnapshot(descriptor, {snapshotName: "snapshot-1", operationId: "restore-1", sizeGb: 96});
  assert.equal(restored.kind, "compute-engine-restore");
  assert.equal(restored.sourceGeneration, 2);
  assert.equal(restored.targetDiskSizeGb, 96);
  assert.equal(calls.at(-1).data.labels["mapache-backup-state"], "restoring");
});

test("snapshot deletion requires an expired verified policy receipt", async () => {
  const calls = [];
  const service = createComputeEngineBackupService({
    request: async (request) => {
      calls.push(request);
      if (request.method === "GET") return {data: {name: "snapshot-1", labels: {
        "mapache-owner-uid": "owner-1", "mapache-workspace-id": "workspace-1", "mapache-runtime-provider": "compute-engine",
      }}};
      return {data: {status: "DONE"}};
    },
  });
  await assert.rejects(() => service.deleteSnapshot(descriptor, "snapshot-1"),
    error => error.code === "vm_backup_deletion_guard_required");
  const record = markBackupVerified({...createBackupRecord({workspaceId: "workspace-1", ownerUid: "owner-1", operationId: "backup-1",
    sourceDisk: "disk-1", sourceGeneration: 1, capturedAt: "2026-01-01T00:00:00.000Z", retentionDays: 1})},
  {workspaceId: "workspace-1", ownerUid: "owner-1", operationId: "backup-1", verifiedAt: "2026-01-01T00:01:00.000Z"});
  const result = await service.deleteSnapshot(descriptor, "snapshot-1", {snapshotRecord: {...record, name: "snapshot-1"},
    ownerUid: "owner-1", workspaceId: "workspace-1", now: "2026-01-03T00:00:00.000Z"});
  assert.equal(result.deleted, true);
  assert.equal(calls.at(-1).method, "DELETE");
});
