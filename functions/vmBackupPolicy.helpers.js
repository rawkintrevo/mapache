"use strict";

const VM_BACKUP_POLICY_VERSION = 1;
const DEFAULT_SNAPSHOT_RETENTION_DAYS = 14;
const MAX_SNAPSHOT_RETENTION_DAYS = 90;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RPO_TARGET_MS = SNAPSHOT_INTERVAL_MS;
const DEFAULT_RTO_TARGET_MS = 60 * 60 * 1000;
const BYTES_PER_GIB = 1024 ** 3;
const CONSISTENCY_MODES = new Set(["crash-consistent", "application-consistent"]);
const ACTIVE_BACKUP_STATES = new Set(["creating", "restoring", "verification-pending"]);

function backupPolicy() {
  return {
    version: VM_BACKUP_POLICY_VERSION,
    schedule: "daily",
    intervalMs: SNAPSHOT_INTERVAL_MS,
    retentionDays: DEFAULT_SNAPSHOT_RETENTION_DAYS,
    maxRetentionDays: MAX_SNAPSHOT_RETENTION_DAYS,
    rpoTargetMs: DEFAULT_RPO_TARGET_MS,
    rtoTargetMs: DEFAULT_RTO_TARGET_MS,
    defaultConsistency: "crash-consistent",
    migrationConsistency: "application-consistent",
  };
}

function createBackupRecord(input = {}) {
  const workspaceId = requiredIdentity(input.workspaceId, "workspace_id");
  const ownerUid = requiredIdentity(input.ownerUid, "owner_uid");
  const operationId = requiredIdentity(input.operationId, "operation_id");
  const sourceDisk = requiredIdentity(input.sourceDisk, "source_disk");
  const sourceGeneration = positiveInteger(input.sourceGeneration, "source_generation");
  const consistency = normalizeConsistency(input.consistency);
  const capturedAt = normalizeTimestamp(input.capturedAt || input.now || new Date().toISOString(), "captured_at");
  const retentionDays = retentionDaysValue(input.retentionDays);
  if (consistency === "application-consistent" && !input.quiescedAt) {
    throw policyError("vm_application_consistency_requires_quiesce");
  }
  const expiresAt = new Date(Date.parse(capturedAt) + retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return {
    version: VM_BACKUP_POLICY_VERSION,
    kind: "compute-engine-snapshot",
    workspaceId,
    ownerUid,
    operationId,
    sourceGeneration,
    sourceDisk,
    sourceDiskId: input.sourceDiskId ? String(input.sourceDiskId) : null,
    consistency,
    capturedAt,
    quiescedAt: input.quiescedAt ? normalizeTimestamp(input.quiescedAt, "quiesced_at") : null,
    recoverablePoint: {
      sourceGeneration,
      sourceDisk,
      sourceDiskId: input.sourceDiskId ? String(input.sourceDiskId) : null,
      capturedAt,
    },
    state: "creating",
    verification: {state: "pending", verifiedAt: null, restoreOperationId: null},
    recoveryTargets: {
      rpoMs: durationValue(input.rpoTargetMs, DEFAULT_RPO_TARGET_MS, "rpo_target"),
      rtoMs: durationValue(input.rtoTargetMs, DEFAULT_RTO_TARGET_MS, "rto_target"),
    },
    retention: {retentionDays, expiresAt},
  };
}

function markBackupVerified(record, evidence = {}) {
  assertRecordIdentity(record, evidence);
  if (record.state === "deleted") throw policyError("vm_backup_already_deleted");
  const verifiedAt = normalizeTimestamp(evidence.verifiedAt || new Date().toISOString(), "verified_at");
  return {
    ...record,
    state: "verified",
    verification: {
      state: "verified",
      verifiedAt,
      restoreOperationId: evidence.restoreOperationId ? String(evidence.restoreOperationId) : null,
      diskName: evidence.diskName ? String(evidence.diskName) : null,
      runtimeReady: evidence.runtimeReady === true,
      fileDigest: evidence.fileDigest ? String(evidence.fileDigest) : null,
      runtimeStateDigest: evidence.runtimeStateDigest ? String(evidence.runtimeStateDigest) : null,
    },
  };
}

function createRestoreReceipt(input = {}) {
  const workspaceId = requiredIdentity(input.workspaceId, "workspace_id");
  const ownerUid = requiredIdentity(input.ownerUid, "owner_uid");
  const operationId = requiredIdentity(input.operationId, "operation_id");
  const sourceSnapshot = requiredIdentity(input.sourceSnapshot, "source_snapshot");
  const targetDisk = requiredIdentity(input.targetDisk, "target_disk");
  const sourceGeneration = positiveInteger(input.sourceGeneration, "source_generation");
  const createdAt = normalizeTimestamp(input.createdAt || new Date().toISOString(), "created_at");
  return {
    version: VM_BACKUP_POLICY_VERSION,
    kind: "compute-engine-restore",
    workspaceId,
    ownerUid,
    operationId,
    sourceSnapshot,
    sourceGeneration,
    targetDisk,
    targetZone: requiredIdentity(input.targetZone, "target_zone"),
    targetDiskSizeGb: positiveInteger(input.targetDiskSizeGb, "target_disk_size"),
    createdAt,
    state: "pending-verification",
    verification: {state: "pending", verifiedAt: null, runtimeReady: false, fileDigest: null},
  };
}

function markRestoreVerified(receipt, evidence = {}) {
  if (receipt?.kind !== "compute-engine-restore" || receipt?.version !== VM_BACKUP_POLICY_VERSION) {
    throw policyError("vm_restore_receipt_invalid");
  }
  assertIdentityFields(receipt, evidence);
  if (receipt.state === "deleted") throw policyError("vm_restore_already_deleted");
  const verifiedAt = normalizeTimestamp(evidence.verifiedAt || new Date().toISOString(), "verified_at");
  return {
    ...receipt,
    state: "verified",
    verification: {
      state: "verified",
      verifiedAt,
      runtimeReady: evidence.runtimeReady === true,
      fileDigest: evidence.fileDigest ? String(evidence.fileDigest) : null,
      diskId: evidence.diskId ? String(evidence.diskId) : null,
    },
  };
}

function planSnapshotRetention({snapshots = [], now = new Date(), ownerUid, workspaceId} = {}) {
  const timestamp = toMillis(now, "now");
  const result = {delete: [], hold: [], quarantine: []};
  for (const snapshot of snapshots) {
    const name = String(snapshot?.name || "").trim() || null;
    if (!name || (ownerUid && snapshot.ownerUid !== ownerUid) || (workspaceId && snapshot.workspaceId !== workspaceId)) {
      result.quarantine.push({name, reason: "ownership_unverified"});
      continue;
    }
    if (snapshot.migrationInProgress === true || snapshot.migrationOperationId) {
      result.hold.push({name, reason: "migration_in_progress"});
      continue;
    }
    if (ACTIVE_BACKUP_STATES.has(String(snapshot.state || "").trim().toLowerCase())) {
      result.hold.push({name, reason: "backup_operation_in_progress"});
      continue;
    }
    if (snapshot.protected === true || snapshot.rollbackProtected === true) {
      result.hold.push({name, reason: "rollback_protected"});
      continue;
    }
    if (snapshot.verification?.state !== "verified" && snapshot.state !== "verified") {
      result.hold.push({name, reason: "verification_required"});
      continue;
    }
    const expiresAt = snapshot.retention?.expiresAt || snapshot.expiresAt;
    if (!expiresAt || toMillis(expiresAt, "expires_at") > timestamp) {
      result.hold.push({name, reason: "retention_window_open"});
      continue;
    }
    result.delete.push({name, reason: "retention_expired"});
  }
  return result;
}

function assertSnapshotDeletionAllowed({snapshot, mode = "retention", ownerUid, workspaceId, now = new Date(), computeAbsent, diskDetached, admissionsBlocked} = {}) {
  if (!snapshot || (ownerUid && snapshot.ownerUid !== ownerUid) || (workspaceId && snapshot.workspaceId !== workspaceId)) {
    throw policyError("vm_backup_ownership_mismatch");
  }
  if (snapshot.migrationInProgress === true || snapshot.migrationOperationId) {
    throw policyError("vm_backup_migration_in_progress");
  }
  if (ACTIVE_BACKUP_STATES.has(String(snapshot.state || "").trim().toLowerCase())) {
    throw policyError("vm_backup_operation_in_progress");
  }
  if (snapshot.protected === true || snapshot.rollbackProtected === true) {
    throw policyError("vm_backup_rollback_protected");
  }
  if (snapshot.verification?.state !== "verified" && snapshot.state !== "verified") {
    throw policyError("vm_backup_verification_required");
  }
  if (mode === "workspace-deletion") {
    if (admissionsBlocked !== true || computeAbsent !== true || diskDetached !== true) {
      throw policyError("vm_backup_deletion_cleanup_unconfirmed");
    }
  } else if (mode !== "retention") {
    throw policyError("vm_backup_deletion_mode_invalid");
  }
  const expiresAt = snapshot.retention?.expiresAt || snapshot.expiresAt;
  if (!expiresAt || toMillis(expiresAt, "expires_at") > toMillis(now, "now")) {
    throw policyError("vm_backup_retention_window_open");
  }
  return true;
}

function planWorkspaceComputeCleanup({workspace = {}, compute = {}, migration = {}} = {}) {
  const deleted = workspace.deleted === true || [workspace.lifecycle, workspace.status]
    .map(value => String(value || "").trim().toLowerCase())
    .some(value => ["deleting", "deleted"].includes(value));
  if (!deleted) return {action: "hold", reason: "pause_never_enters_deletion"};
  if (migration.inProgress === true || migration.fencePresent === true) {
    return {action: "hold", reason: "migration_in_progress"};
  }
  if (compute.unknown === true || compute.instanceAbsent !== true || compute.diskDetached !== true) {
    return {action: "hold", reason: "compute_cleanup_unconfirmed"};
  }
  return {action: "apply-backup-retention", reason: "tombstone_and_compute_cleanup_confirmed"};
}

function diskCapacitySummary({sizeGb, usedBytes, freeBytes, measuredAt = null} = {}) {
  const normalizedSizeGb = Number(sizeGb);
  const capacityBytes = Number.isFinite(normalizedSizeGb) && normalizedSizeGb > 0 ? normalizedSizeGb * BYTES_PER_GIB : null;
  const used = finiteNonNegative(usedBytes);
  const free = finiteNonNegative(freeBytes);
  const headroomBytes = free !== null ? free : capacityBytes !== null && used !== null ? Math.max(0, capacityBytes - used) : null;
  return {
    sizeGb: capacityBytes === null ? null : normalizedSizeGb,
    capacityBytes,
    usedBytes: used,
    freeBytes: free,
    headroomBytes,
    headroomPercent: capacityBytes && headroomBytes !== null ? (headroomBytes / capacityBytes) * 100 : null,
    headroomKnown: headroomBytes !== null,
    measuredAt: measuredAt ? normalizeTimestamp(measuredAt, "measured_at") : null,
  };
}

function assertRecordIdentity(record, input = {}) {
  assertIdentityFields(record, input);
  if (record?.kind !== "compute-engine-snapshot" || record?.version !== VM_BACKUP_POLICY_VERSION) {
    throw policyError("vm_backup_record_version_invalid");
  }
  return true;
}

function assertIdentityFields(record, input = {}) {
  for (const key of ["workspaceId", "ownerUid", "operationId"]) {
    if (input[key] !== undefined && record?.[key] !== input[key]) throw policyError("vm_backup_identity_mismatch");
  }
  return true;
}

function normalizeConsistency(value) {
  const consistency = String(value || "crash-consistent").trim().toLowerCase();
  if (!CONSISTENCY_MODES.has(consistency)) throw policyError("vm_backup_consistency_invalid");
  return consistency;
}

function retentionDaysValue(value) {
  const days = value === undefined ? DEFAULT_SNAPSHOT_RETENTION_DAYS : Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_SNAPSHOT_RETENTION_DAYS) {
    throw policyError("vm_backup_retention_invalid");
  }
  return days;
}

function durationValue(value, fallback, label) {
  const duration = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 365 * 24 * 60 * 60 * 1000) {
    throw policyError(`vm_backup_${label}_invalid`);
  }
  return duration;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw policyError(`vm_backup_${label}_invalid`);
  return number;
}

function requiredIdentity(value, label) {
  const identity = String(value || "").trim();
  if (!identity || identity.length > 200) throw policyError(`vm_backup_${label}_invalid`);
  return identity;
}

function normalizeTimestamp(value, label) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw policyError(`vm_backup_${label}_invalid`);
  return timestamp.toISOString();
}

function toMillis(value, label) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw policyError(`vm_backup_${label}_invalid`);
  return timestamp.getTime();
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function policyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  ACTIVE_BACKUP_STATES,
  CONSISTENCY_MODES,
  DEFAULT_SNAPSHOT_RETENTION_DAYS,
  DEFAULT_RPO_TARGET_MS,
  DEFAULT_RTO_TARGET_MS,
  MAX_SNAPSHOT_RETENTION_DAYS,
  SNAPSHOT_INTERVAL_MS,
  VM_BACKUP_POLICY_VERSION,
  assertRecordIdentity,
  assertSnapshotDeletionAllowed,
  backupPolicy,
  createBackupRecord,
  createRestoreReceipt,
  diskCapacitySummary,
  markBackupVerified,
  markRestoreVerified,
  planSnapshotRetention,
  planWorkspaceComputeCleanup,
};
