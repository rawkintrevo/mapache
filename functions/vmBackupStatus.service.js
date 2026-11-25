"use strict";

const {COMPUTE_ENGINE_BACKEND} = require("./runtimeProvider.helpers");

const INVENTORY_REPORTS = "vmBackupInventoryReports_v2";
const RECOVERY_OPERATIONS = "vmBackupRecoveryOperations_v2";
const RECOVERY_REPORTS = "vmBackupRecoveryReports_v2";
const MAX_ITEMS = 20;

function createVmBackupStatusService({db, now = Date.now} = {}) {
  if (!db) throw new Error("vm_backup_status_dependencies_required");

  return {getWorkspace};

  async function getWorkspace({workspaceId, ownerUid} = {}) {
    const runtimeSnapshot = await db.collection("vmRuntimes_v2").doc(workspaceId).get();
    const runtime = runtimeSnapshot.data();
    if (!runtimeSnapshot.exists || runtime?.ownerUid !== ownerUid || runtime.backend !== COMPUTE_ENGINE_BACKEND) {
      throw statusError(404, "not_found");
    }
    const [inventorySnapshot, operationsSnapshot, reportsSnapshot] = await Promise.all([
      db.collection(INVENTORY_REPORTS).doc(workspaceId).get(),
      db.collection(RECOVERY_OPERATIONS).where("workspaceId", "==", workspaceId).limit(MAX_ITEMS).get(),
      db.collection(RECOVERY_REPORTS).doc(workspaceId).collection("reports").limit(MAX_ITEMS).get(),
    ]);
    const operations = operationsSnapshot.docs
        .map(doc => sanitizeRecoveryOperation(doc.id, doc.data(), ownerUid, workspaceId))
        .filter(Boolean)
        .sort((left, right) => (right.updatedAtMs || 0) - (left.updatedAtMs || 0));
    const reports = reportsSnapshot.docs
        .map(doc => sanitizeRecoveryReport(doc.id, doc.data(), ownerUid, workspaceId))
        .filter(Boolean)
        .sort((left, right) => Date.parse(right.verifiedAt || "") - Date.parse(left.verifiedAt || ""));
    return {
      version: 1,
      kind: "compute-engine-backup-status",
      workspaceId,
      generation: positiveInteger(runtime.generation),
      state: safeState(runtime.state),
      lifecycleEnabled: runtime.lifecycleEnabled === true,
      backupPolicy: sanitizePolicy(runtime.backupPolicy),
      inventory: inventorySnapshot.exists ? sanitizeInventory(inventorySnapshot.data(), ownerUid) : null,
      recovery: {
        pendingCount: operations.filter(operation => operation.status === "pending").length,
        latestOperation: operations[0] || null,
        latestReport: reports[0] || null,
      },
      observedAt: new Date(now()).toISOString(),
    };
  }
}

function sanitizeInventory(report = {}, ownerUid) {
  if (report.ownerUid !== ownerUid) return null;
  return {
    observedAt: safeTimestamp(report.observedAt),
    compute: {
      instancePresent: report.compute?.instancePresent === true,
      instanceStatus: safeState(report.compute?.instanceStatus),
      instanceRunning: report.compute?.instanceRunning === true,
      diskPresent: report.compute?.diskPresent === true,
      diskStatus: safeState(report.compute?.diskStatus),
      diskAttached: nullableBoolean(report.compute?.diskAttached),
      diskSizeGb: finitePositive(report.compute?.diskSizeGb),
      headroomKnown: report.compute?.headroomKnown === true,
    },
    backups: {
      observed: boundedCount(report.backups?.observed),
      providerObserved: boundedCount(report.backups?.providerObserved),
      verified: boundedCount(report.backups?.verified),
      sourceDigestsVerified: boundedCount(report.backups?.sourceDigestsVerified),
      sourceDigestsMissing: boundedCount(report.backups?.sourceDigestsMissing),
      backupAgeMs: finiteNonNegative(report.backups?.backupAgeMs),
      oldestPending: report.backups?.oldestPending === true,
      retentionCandidates: boundedReasons(report.backups?.retentionCandidates),
      held: boundedReasons(report.backups?.held),
      quarantined: boundedReasons(report.backups?.quarantined),
    },
    strandedResources: {
      diskDetached: nullableBoolean(report.strandedResources?.diskDetached),
      instanceWithoutDisk: report.strandedResources?.instanceWithoutDisk === true,
      diskWithoutInstance: report.strandedResources?.diskWithoutInstance === true,
      ownedInstanceCount: boundedCount(report.strandedResources?.ownedInstanceCount),
      ownedDiskCount: boundedCount(report.strandedResources?.ownedDiskCount),
      unexpectedOwnedInstanceCount: boundedArrayLength(report.strandedResources?.unexpectedOwnedInstances),
      unexpectedOwnedDiskCount: boundedArrayLength(report.strandedResources?.unexpectedOwnedDisks),
      resourceInventoryKnown: report.strandedResources?.resourceInventoryKnown === true,
      cleanupAllowed: false,
      reason: "inventory_is_read_only",
    },
    cost: sanitizeCost(report.cost),
  };
}

function sanitizeRecoveryOperation(id, operation = {}, ownerUid, workspaceId) {
  if (operation.ownerUid !== ownerUid || operation.workspaceId !== workspaceId) return null;
  return {
    operationId: safeIdentity(id),
    status: safeState(operation.status),
    phase: safePhase(operation.phase),
    attempts: boundedCount(operation.attempts),
    createdAtMs: safeMillis(operation.createdAtMs),
    updatedAtMs: safeMillis(operation.updatedAtMs),
    nextAttemptAtMs: safeMillis(operation.nextAttemptAtMs),
    lastError: safeErrorCode(operation.lastError),
    backupId: safeIdentity(operation.backupId),
    restoreStartedAtMs: safeMillis(operation.restoreStartedAtMs),
  };
}

function sanitizeRecoveryReport(id, report = {}, ownerUid, workspaceId) {
  if (report.ownerUid !== ownerUid || report.workspaceId !== workspaceId) return null;
  return {
    operationId: safeIdentity(report.operationId || id),
    verifiedAt: safeTimestamp(report.verifiedAt),
    runtimeReady: report.runtimeReady === true,
    startupStageTimingsMs: sanitizeTimings(report.startupStageTimingsMs),
    rpoMs: finiteNonNegative(report.rpoMs),
    rtoMs: finiteNonNegative(report.rtoMs),
    rpoTargetMs: finitePositive(report.rpoTargetMs),
    rtoTargetMs: finitePositive(report.rtoTargetMs),
    rpoWithinTarget: report.rpoWithinTarget === true,
    rtoWithinTarget: report.rtoWithinTarget === true,
    passed: report.passed === true,
    failureCode: safeErrorCode(report.failureCode),
  };
}

function sanitizePolicy(policy = {}) {
  return {
    enabled: policy.enabled === true,
    schedule: policy.schedule === "daily" ? "daily" : null,
    retentionDays: boundedCount(policy.retentionDays),
    rpoTargetMs: finitePositive(policy.rpoTargetMs),
    rtoTargetMs: finitePositive(policy.rtoTargetMs),
  };
}

function sanitizeCost(cost = {}) {
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return null;
  return {
    retainedStorageMonthlyUsd: finiteNonNegative(cost.retainedStorageMonthlyUsd),
    snapshotStorageMonthlyUsd: finiteNonNegative(cost.snapshotStorageMonthlyUsd),
    computeMonthlyUsd: finiteNonNegativeOrNull(cost.computeMonthlyUsd),
    totalKnownMonthlyUsd: finiteNonNegative(cost.totalKnownMonthlyUsd),
    ratesAreEstimates: cost.ratesAreEstimates === true,
    unknownComponents: Array.isArray(cost.unknownComponents) ? cost.unknownComponents
        .filter(value => /^[a-z][a-z0-9_-]{0,31}$/.test(String(value))).slice(0, 16) : [],
  };
}

function boundedReasons(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).map(item => ({
    name: safeIdentity(item?.name),
    reason: safeErrorCode(item?.reason),
  }));
}

function sanitizeTimings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => /^[a-z][a-z0-9_-]{0,31}$/.test(key) &&
    Number.isSafeInteger(Number(item)) && Number(item) >= 0 && Number(item) <= 24 * 60 * 60 * 1000).slice(0, 32));
}

function safeState(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(normalized) ? normalized : null;
}

function safePhase(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^(?:restore|verify|complete|failed|delete|snapshot|pending)$/.test(normalized) ? normalized : null;
}

function safeErrorCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,119}$/.test(normalized) ? normalized : null;
}

function safeIdentity(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized) ? normalized : null;
}

function safeTimestamp(value) {
  const timestamp = new Date(value || "");
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function safeMillis(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

function boundedCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= 100000 ? count : 0;
}

function boundedArrayLength(value) {
  return Array.isArray(value) ? Math.min(value.length, 100000) : 0;
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteNonNegativeOrNull(value) {
  return value === null || value === undefined ? null : finiteNonNegative(value);
}

function statusError(status, publicMessage) {
  const error = new Error(publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  return error;
}

module.exports = {createVmBackupStatusService, sanitizeCost, sanitizeInventory, sanitizeRecoveryOperation, sanitizeRecoveryReport};
