"use strict";

const {createHash, randomUUID} = require("node:crypto");
const {COMPUTE_ENGINE_BACKEND, normalizeRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {hasVmMigrationFence} = require("./vmMigrationFence.helpers");
const {
  DEFAULT_RPO_TARGET_MS,
  DEFAULT_RTO_TARGET_MS,
  SNAPSHOT_INTERVAL_MS,
  backupPolicy,
  createBackupRecord,
  markBackupVerified,
  planSnapshotRetention,
} = require("./vmBackupPolicy.helpers");

const OPERATIONS = "vmBackupOperations_v2";
const BACKUPS = "vmBackups_v2";
const CLAIM_MS = 15 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const MAX_SCAN = 100;

/**
 * Durable, opt-in backup controller for retained Compute Engine disks.
 *
 * Provider calls happen outside Firestore transactions. The operation claim,
 * backup receipt and retry time make an interrupted provider call visible and
 * prevent a later tick from silently creating a second snapshot for the same
 * schedule slot.
 */
function createVmBackupSchedulerService({db, backup, captureRuntimeEvidence, now = Date.now, logger = console} = {}) {
  if (!db || !backup) throw new Error("vm_backup_scheduler_dependencies_required");

  return {
    requestBackup,
    runTick,
    step,
    scheduleRetention,
  };

  async function requestBackup({workspaceId, ownerUid, requestId, expectedGeneration, consistency, retentionDays} = {}) {
    const operationId = hashId(`${identity(workspaceId)}:manual:${identity(requestId)}`);
    return reserveBackup({operationId, workspaceId, ownerUid, expectedGeneration, consistency, retentionDays});
  }

  async function runTick() {
    const runtimeSnapshot = await db.collection("vmRuntimes_v2").limit(MAX_SCAN).get();
    const result = {checked: runtimeSnapshot.docs.length, scheduled: 0, retentionScheduled: 0, processed: 0, failed: 0, disabled: false};
    for (const doc of runtimeSnapshot.docs) {
      const workspaceId = doc.id;
      const runtime = doc.data() || {};
      if (!isEligible(runtime)) continue;
      try {
        const operationId = await reserveScheduledBackup(workspaceId, runtime);
        if (operationId) result.scheduled++;
        result.retentionScheduled += await scheduleRetention({workspaceId, runtime});
      } catch (error) {
        result.failed++;
        logger.warn?.("VM backup scheduling failed", {workspaceId, errorCode: safeErrorCode(error)});
      }
    }

    const pending = await db.collection(OPERATIONS).where("status", "==", "pending").limit(MAX_SCAN).get();
    const eligible = pending.docs.filter(doc => {
      const operation = doc.data() || {};
      return !(operation.claim?.expiresAt > now()) && !(operation.nextAttemptAtMs > now());
    }).slice(0, 4);
    const outcomes = await Promise.allSettled(eligible.map(doc => step(doc.id)));
    outcomes.forEach(outcome => {
      if (outcome.status === "fulfilled") result.processed++;
      else result.failed++;
    });
    return result;
  }

  async function reserveScheduledBackup(workspaceId, runtime) {
    const policy = normalizedPolicy(runtime.backupPolicy);
    const intervalMs = policy.intervalMs;
    const scheduledSlotMs = Math.floor(now() / intervalMs) * intervalMs;
    if (Number(runtime.backupPolicy?.lastScheduledSlotMs || 0) >= scheduledSlotMs) return null;
    const operationId = hashId(`${workspaceId}:scheduled:${runtime.generation || 1}:${scheduledSlotMs}`);
    return reserveBackup({operationId, workspaceId, ownerUid: runtime.ownerUid,
      expectedGeneration: runtime.generation, consistency: policy.consistency,
      retentionDays: policy.retentionDays, scheduledSlotMs});
  }

  async function reserveBackup({operationId, workspaceId, ownerUid, expectedGeneration, consistency, retentionDays, scheduledSlotMs} = {}) {
    identity(operationId); identity(workspaceId); identity(ownerUid);
    const runtimeRef = db.collection("vmRuntimes_v2").doc(workspaceId);
    const operationRef = db.collection(OPERATIONS).doc(operationId);
    return db.runTransaction(async tx => {
      const [runtimeSnap, existing] = await Promise.all([tx.get(runtimeRef), tx.get(operationRef)]);
      if (existing.exists) return {operationId, status: existing.data()?.status || "pending", reused: true};
      const runtime = runtimeSnap.data() || {};
      assertRuntime(runtime, workspaceId, ownerUid, expectedGeneration);
      if (await hasVmMigrationFence(tx, db, workspaceId)) return null;
      if (runtime.activeOperationId) return null;
      const descriptor = normalizeRuntimeDescriptor(runtime.runtimeProvider || runtime.runtimeProviderDescriptor,
          {workspaceId, ownerUid});
      const capturedAt = new Date(now()).toISOString();
      const record = createBackupRecord({workspaceId, ownerUid, operationId,
        sourceDisk: descriptor.dataDiskName, sourceDiskId: descriptor.dataDiskName,
        sourceGeneration: descriptor.generation, consistency: consistency || "crash-consistent",
        retentionDays, capturedAt, rpoTargetMs: normalizedPolicy(runtime.backupPolicy).rpoTargetMs,
        rtoTargetMs: normalizedPolicy(runtime.backupPolicy).rtoTargetMs});
      tx.set(operationRef, {
        version: 1,
        kind: "compute-engine-backup",
        workspaceId,
        ownerUid,
        operationId,
        scheduled: Number.isSafeInteger(scheduledSlotMs),
        scheduledSlotMs: Number.isSafeInteger(scheduledSlotMs) ? scheduledSlotMs : null,
        descriptor,
        phase: "snapshot",
        status: "pending",
        claim: null,
        attempts: 0,
        backupRecord: record,
        createdAtMs: now(),
        updatedAtMs: now(),
      });
      if (Number.isSafeInteger(scheduledSlotMs)) {
        tx.update(runtimeRef, {backupPolicy: {
          ...normalizedPolicy(runtime.backupPolicy),
          lastScheduledSlotMs: scheduledSlotMs,
          lastScheduledOperationId: operationId,
        }});
      }
      return {operationId, status: "pending", reused: false};
    });
  }

  async function scheduleRetention({workspaceId, runtime} = {}) {
    const items = await db.collection(BACKUPS).doc(workspaceId).collection("items").limit(MAX_SCAN).get();
    const plan = planSnapshotRetention({snapshots: items.docs.map(doc => ({id: doc.id, ...doc.data()})),
      ownerUid: runtime.ownerUid, workspaceId, now: new Date(now())});
    let scheduled = 0;
    for (const candidate of plan.delete) {
      const item = items.docs.find(doc => (doc.data()?.name || doc.id) === candidate.name);
      if (!item) continue;
      const record = {...item.data(), name: candidate.name};
      const operationId = hashId(`${workspaceId}:retention:${candidate.name}:${record.retention?.expiresAt || "unknown"}`);
      const operationRef = db.collection(OPERATIONS).doc(operationId);
      const existing = await operationRef.get();
      if (existing.exists) continue;
      const descriptor = normalizeRuntimeDescriptor(runtime.runtimeProvider || runtime.runtimeProviderDescriptor,
          {workspaceId, ownerUid: runtime.ownerUid});
      await operationRef.set({version: 1, kind: "compute-engine-backup-retention", workspaceId,
        ownerUid: runtime.ownerUid, operationId, phase: "delete", status: "pending", claim: null,
        descriptor, snapshotRecord: record, backupRecordId: item.id, createdAtMs: now(), updatedAtMs: now()});
      scheduled++;
    }
    return scheduled;
  }

  async function step(operationId) {
    const operationRef = db.collection(OPERATIONS).doc(operationId);
    const claimId = randomUUID();
    const operation = await db.runTransaction(async tx => {
      const snapshot = await tx.get(operationRef);
      const value = snapshot.data();
      if (!value || value.status !== "pending" || value.claim?.expiresAt > now() || value.nextAttemptAtMs > now()) return null;
      tx.update(operationRef, {claim: {id: claimId, expiresAt: now() + CLAIM_MS}, attempts: Number(value.attempts || 0) + 1, updatedAtMs: now()});
      return {...value, operationId};
    });
    if (!operation) return {claimed: false};
    try {
      if (operation.kind === "compute-engine-backup-retention") return await deleteExpiredSnapshot(operation, operationRef, claimId);
      if (operation.phase === "snapshot") {
        const record = operation.backupRecord;
        let sourceRuntimeEvidence = null;
        let sourceRuntimeEvidenceError = null;
        if (typeof captureRuntimeEvidence === "function") {
          try {
            sourceRuntimeEvidence = await captureRuntimeEvidence({workspaceId: operation.workspaceId,
              ownerUid: operation.ownerUid, descriptor: operation.descriptor});
          } catch (error) {
            sourceRuntimeEvidenceError = safeErrorCode(error);
            logger.warn?.("VM backup source runtime evidence unavailable", {workspaceId: operation.workspaceId,
              errorCode: sourceRuntimeEvidenceError});
          }
        }
        const created = await backup.createSnapshot(operation.descriptor, {
          snapshotName: `mapache-${operation.workspaceId}-${operation.operationId.slice(0, 12)}`,
          operationId,
          retentionDays: record.retention.retentionDays,
          consistency: record.consistency,
          quiescedAt: record.quiescedAt,
          sourceDiskId: record.sourceDiskId,
          sourceGeneration: record.sourceGeneration,
        });
        const namedRecord = {...record, name: created.name, providerOperation: created.operation || null,
          sourceRuntimeEvidence, sourceRuntimeEvidenceError};
        await db.collection(BACKUPS).doc(operation.workspaceId).collection("items").doc(operationId).set(namedRecord);
        await commit(operationRef, claimId, operation, {phase: "verify", backupRecord: namedRecord,
          snapshotName: created.name, lastError: null});
        return {claimed: true, phase: "verify"};
      }
      if (operation.phase === "verify") {
        const snapshot = await backup.inspectSnapshot(operation.descriptor, operation.snapshotName);
        if (!isReady(snapshot)) {
          await commit(operationRef, claimId, operation, {nextAttemptAtMs: now() + RETRY_MS,
            lastError: "vm_backup_snapshot_not_ready"});
          return {claimed: true, pending: true};
        }
        const verified = markBackupVerified(operation.backupRecord, {
          workspaceId: operation.workspaceId, ownerUid: operation.ownerUid, operationId,
          verifiedAt: new Date(now()).toISOString(), restoreOperationId: null,
          diskName: operation.backupRecord.sourceDisk, runtimeReady: true,
          fileDigest: operation.backupRecord.sourceRuntimeEvidence?.fileDigest,
          runtimeStateDigest: operation.backupRecord.sourceRuntimeEvidence?.runtimeStateDigest,
        });
        await db.collection(BACKUPS).doc(operation.workspaceId).collection("items").doc(operationId).set(verified);
        await commit(operationRef, claimId, operation, {phase: "complete", status: "succeeded",
          backupRecord: verified, completedAtMs: now(), lastError: null});
        return {claimed: true, verified: true};
      }
      throw new Error("vm_backup_operation_phase_invalid");
    } catch (error) {
      await releaseForRetry(operationRef, claimId, error);
      return {claimed: true, failed: true, errorCode: safeErrorCode(error)};
    }
  }

  async function deleteExpiredSnapshot(operation, operationRef, claimId) {
    const result = await backup.deleteSnapshot(operation.descriptor, operation.snapshotRecord.name, {
      snapshotRecord: operation.snapshotRecord, mode: "retention", ownerUid: operation.ownerUid,
      workspaceId: operation.workspaceId, now: new Date(now()), providerOperation: operation.providerOperation,
    });
    if (result.deleted !== true) {
      await commit(operationRef, claimId, operation, {providerOperation: result.operation || operation.providerOperation || null,
        nextAttemptAtMs: now() + RETRY_MS, lastError: "vm_backup_delete_pending"});
      return {claimed: true, pending: true};
    }
    const backupRef = db.collection(BACKUPS).doc(operation.workspaceId).collection("items").doc(operation.backupRecordId);
    await backupRef.set({...operation.snapshotRecord, state: "deleted", deletedAt: new Date(now()).toISOString(), deleteOperation: result.operation || null});
    await commit(operationRef, claimId, operation, {phase: "complete", status: "succeeded", completedAtMs: now(), lastError: null});
    return {claimed: true, deleted: true};
  }

  async function commit(ref, claimId, operation, fields) {
    return db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.claim?.id !== claimId || current.phase !== operation.phase) throw new Error("vm_backup_worker_claim_lost");
      tx.update(ref, {...fields, claim: null, updatedAtMs: now()});
    });
  }

  async function releaseForRetry(ref, claimId, error) {
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.claim?.id !== claimId) return;
      tx.update(ref, {claim: null, nextAttemptAtMs: now() + RETRY_MS,
        lastError: safeErrorCode(error), updatedAtMs: now()});
    });
  }
}

function normalizedPolicy(value = {}) {
  const defaults = backupPolicy();
  const consistency = ["crash-consistent", "application-consistent"].includes(value.consistency) ? value.consistency : defaults.defaultConsistency;
  return {
    enabled: value.enabled === true,
    schedule: value.schedule || defaults.schedule,
    intervalMs: Number.isSafeInteger(Number(value.intervalMs)) && Number(value.intervalMs) >= SNAPSHOT_INTERVAL_MS ? Number(value.intervalMs) : defaults.intervalMs,
    retentionDays: value.retentionDays === undefined ? defaults.retentionDays : value.retentionDays,
    rpoTargetMs: durationOrDefault(value.rpoTargetMs, DEFAULT_RPO_TARGET_MS),
    rtoTargetMs: durationOrDefault(value.rtoTargetMs, DEFAULT_RTO_TARGET_MS),
    consistency,
    lastScheduledSlotMs: value.lastScheduledSlotMs || null,
    lastScheduledOperationId: value.lastScheduledOperationId || null,
  };
}

function durationOrDefault(value, fallback) {
  const duration = Number(value);
  return Number.isSafeInteger(duration) && duration > 0 ? duration : fallback;
}

function isEligible(runtime = {}) {
  const policy = normalizedPolicy(runtime.backupPolicy);
  return policy.enabled && policy.schedule === "daily" && runtime.lifecycleEnabled === true &&
    runtime.backend === COMPUTE_ENGINE_BACKEND && ["active", "stopped"].includes(runtime.state);
}

function assertRuntime(runtime, workspaceId, ownerUid, expectedGeneration) {
  if (runtime.ownerUid !== ownerUid || runtime.backend !== COMPUTE_ENGINE_BACKEND || runtime.lifecycleEnabled !== true) throw new Error("vm_backup_runtime_not_admitted");
  if (expectedGeneration !== undefined && Number(runtime.generation) !== Number(expectedGeneration)) throw new Error("vm_backup_generation_mismatch");
  if (!isEligible(runtime)) throw new Error("vm_backup_policy_not_enabled");
  if (!workspaceId) throw new Error("vm_backup_workspace_invalid");
}

function isReady(snapshot = {}) {
  return ["READY", "DONE", "SUCCESS", "COMPLETED"].includes(String(snapshot.status || "").toUpperCase());
}

function identity(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) throw new Error("vm_backup_identity_invalid");
  return normalized;
}

function hashId(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeErrorCode(error) {
  return String(error?.publicMessage || error?.code || error?.message || "vm_backup_operation_failed").slice(0, 120);
}

module.exports = {BACKUPS, CLAIM_MS, OPERATIONS, createVmBackupSchedulerService, normalizedPolicy};
