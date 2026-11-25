"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertSnapshotDeletionAllowed,
  backupPolicy,
  createBackupRecord,
  createRestoreReceipt,
  diskCapacitySummary,
  markBackupVerified,
  markRestoreVerified,
  planSnapshotRetention,
  planWorkspaceComputeCleanup,
} = require("./vmBackupPolicy.helpers");

const capturedAt = "2026-01-01T00:00:00.000Z";

function verifiedSnapshot(overrides = {}) {
  const record = createBackupRecord({workspaceId: "workspace-1", ownerUid: "owner-1", operationId: "backup-1",
    sourceDisk: "mapache-disk-1", sourceGeneration: 2, capturedAt, retentionDays: 1});
  return markBackupVerified({...record, ...overrides}, {workspaceId: "workspace-1", ownerUid: "owner-1", operationId: "backup-1", verifiedAt: capturedAt});
}

test("backup policy selects daily crash-consistent snapshots and bounded retention", () => {
  assert.deepEqual(backupPolicy(), {
    version: 1,
    schedule: "daily",
    intervalMs: 24 * 60 * 60 * 1000,
    retentionDays: 14,
    maxRetentionDays: 90,
    rpoTargetMs: 24 * 60 * 60 * 1000,
    rtoTargetMs: 60 * 60 * 1000,
    defaultConsistency: "crash-consistent",
    migrationConsistency: "application-consistent",
  });
});

test("application-consistent records require a quiesce receipt", () => {
  assert.throws(() => createBackupRecord({workspaceId: "workspace-1", ownerUid: "owner-1", operationId: "backup-1",
    sourceDisk: "disk-1", sourceGeneration: 1, consistency: "application-consistent", capturedAt}),
  error => error.code === "vm_application_consistency_requires_quiesce");
  const record = createBackupRecord({workspaceId: "workspace-1", ownerUid: "owner-1", operationId: "backup-1",
    sourceDisk: "disk-1", sourceGeneration: 1, consistency: "application-consistent", quiescedAt: capturedAt, capturedAt});
  assert.equal(record.recoverablePoint.sourceGeneration, 1);
  assert.equal(record.quiescedAt, capturedAt);
  assert.deepEqual(record.recoveryTargets, {rpoMs: 24 * 60 * 60 * 1000, rtoMs: 60 * 60 * 1000});
});

test("retention planning never deletes in-progress, unverified, or migration snapshots", () => {
  const expired = verifiedSnapshot();
  const plan = planSnapshotRetention({now: "2026-01-03T00:00:00.000Z", ownerUid: "owner-1", workspaceId: "workspace-1", snapshots: [
    {name: expired.name || "expired", ...expired},
    {name: "active", ...expired, state: "creating"},
    {name: "migration", ...expired, migrationOperationId: "migration-1"},
    {name: "wrong-owner", ...expired, ownerUid: "other-owner"},
  ]});
  assert.equal(plan.delete.length, 1);
  assert.equal(plan.delete[0].reason, "retention_expired");
  assert.deepEqual(plan.hold.map(item => [item.name, item.reason]), [
    ["active", "backup_operation_in_progress"],
    ["migration", "migration_in_progress"],
  ]);
  assert.deepEqual(plan.quarantine, [{name: "wrong-owner", reason: "ownership_unverified"}]);
});

test("workspace deletion requires tombstone, blocked admissions, absent compute, and detached disk", () => {
  const snapshot = verifiedSnapshot();
  assert.throws(() => assertSnapshotDeletionAllowed({snapshot, mode: "workspace-deletion", ownerUid: "owner-1",
    workspaceId: "workspace-1", now: "2026-01-03T00:00:00.000Z", admissionsBlocked: true,
    computeAbsent: true, diskDetached: false}), error => error.code === "vm_backup_deletion_cleanup_unconfirmed");
  assert.equal(assertSnapshotDeletionAllowed({snapshot, mode: "workspace-deletion", ownerUid: "owner-1",
    workspaceId: "workspace-1", now: "2026-01-03T00:00:00.000Z", admissionsBlocked: true,
    computeAbsent: true, diskDetached: true}), true);
});

test("pause is not a deletion admission", () => {
  assert.deepEqual(planWorkspaceComputeCleanup({workspace: {state: "stopped"}, compute: {instanceAbsent: true, diskDetached: true}}), {
    action: "hold", reason: "pause_never_enters_deletion",
  });
  assert.deepEqual(planWorkspaceComputeCleanup({workspace: {deleted: true, lifecycle: "deleting"},
    compute: {instanceAbsent: true, diskDetached: true}}), {
    action: "apply-backup-retention", reason: "tombstone_and_compute_cleanup_confirmed",
  });
});

test("disk headroom is explicit when measurements are unavailable", () => {
  assert.deepEqual(diskCapacitySummary({sizeGb: 64, usedBytes: 32 * 1024 ** 3, measuredAt: capturedAt}), {
    sizeGb: 64,
    capacityBytes: 64 * 1024 ** 3,
    usedBytes: 32 * 1024 ** 3,
    freeBytes: null,
    headroomBytes: 32 * 1024 ** 3,
    headroomPercent: 50,
    headroomKnown: true,
    measuredAt: capturedAt,
  });
  assert.equal(diskCapacitySummary({sizeGb: 64}).headroomKnown, false);
});

test("restore receipts preserve source generation and exact target ownership", () => {
  const receipt = createRestoreReceipt({workspaceId: "workspace-1", ownerUid: "owner-1", operationId: "restore-1",
    sourceSnapshot: "snapshot-1", sourceGeneration: 2, targetDisk: "restore-disk-1", targetZone: "us-central1-a",
    targetDiskSizeGb: 64, createdAt: capturedAt});
  const verified = markRestoreVerified(receipt, {workspaceId: "workspace-1", ownerUid: "owner-1", operationId: "restore-1",
    verifiedAt: "2026-01-01T00:05:00.000Z", runtimeReady: true, fileDigest: "sha256:abc"});
  assert.equal(verified.state, "verified");
  assert.equal(verified.sourceGeneration, 2);
  assert.equal(verified.verification.runtimeReady, true);
  assert.equal(verified.verification.fileDigest, "sha256:abc");
});
