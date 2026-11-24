"use strict";

const {createHash, randomUUID} = require("node:crypto");
const {COMPUTE_ENGINE_BACKEND, normalizeRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {hasVmMigrationFence} = require("./vmMigrationFence.helpers");
const {
  DEFAULT_RPO_TARGET_MS,
  DEFAULT_RTO_TARGET_MS,
  backupPolicy,
  markRestoreVerified,
} = require("./vmBackupPolicy.helpers");

const OPERATIONS = "vmBackupRecoveryOperations_v2";
const REPORTS = "vmBackupRecoveryReports_v2";
const BACKUPS = "vmBackups_v2";
const CLAIM_MS = 15 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const MAX_SCAN = 100;

/**
 * Durable restore controller. The provider creates the fresh disk; the
 * injected runtime verifier must boot fresh compute, compare user-file and
 * runtime-state digests, and attest authenticated runner readiness. Keeping
 * that verifier behind an adapter prevents a disk-create receipt from being
 * mistaken for a successful recovery.
 */
function createVmBackupRecoveryService({db, backup, restoreRuntime, now = Date.now, logger = console} = {}) {
  if (!db || !backup || !restoreRuntime || typeof restoreRuntime.verify !== "function" ||
      typeof restoreRuntime.cleanup !== "function") {
    throw new Error("vm_backup_recovery_dependencies_required");
  }

  return {requestRestore, runTick, step};

  async function requestRestore({workspaceId, ownerUid, requestId, backupId, expectedGeneration, targetDiskName, targetSizeGb} = {}) {
    const operationId = hashId(`${identity(workspaceId)}:restore:${identity(requestId)}`);
    identity(backupId);
    const runtimeRef = db.collection("vmRuntimes_v2").doc(workspaceId);
    const operationRef = db.collection(OPERATIONS).doc(operationId);
    const backupRef = db.collection(BACKUPS).doc(workspaceId).collection("items").doc(backupId);
    return db.runTransaction(async tx => {
      const [runtimeSnap, existing, backupSnap] = await Promise.all([
        tx.get(runtimeRef), tx.get(operationRef), tx.get(backupRef),
      ]);
      if (existing.exists) return {operationId, status: existing.data()?.status || "pending", reused: true};
      const runtime = runtimeSnap.data() || {};
      assertRuntime(runtime, workspaceId, ownerUid, expectedGeneration);
      if (await hasVmMigrationFence(tx, db, workspaceId)) throw recoveryError("vm_restore_migration_in_progress");
      const record = backupSnap.data();
      assertBackupRecord(record, workspaceId, ownerUid, backupId);
      const descriptor = normalizeRuntimeDescriptor(runtime.runtimeProvider || runtime.runtimeProviderDescriptor,
          {workspaceId, ownerUid});
      const target = safeDiskName(targetDiskName || `${descriptor.dataDiskName}-restore-${operationId.slice(0, 8)}`);
      if (target === descriptor.dataDiskName) throw recoveryError("vm_restore_target_must_be_fresh");
      tx.set(operationRef, {
        version: 1,
        kind: "compute-engine-backup-restore",
        workspaceId,
        ownerUid,
        operationId,
        backupId,
        snapshotName: record.name,
        targetDiskName: target,
        targetSizeGb: targetSizeGb === undefined ? null : positiveInteger(targetSizeGb, "target_size"),
        sourceGeneration: record.sourceGeneration,
        descriptor,
        phase: "restore",
        status: "pending",
        claim: null,
        attempts: 0,
        backupRecord: record,
        createdAtMs: now(),
        updatedAtMs: now(),
      });
      return {operationId, status: "pending", reused: false};
    });
  }

  async function runTick() {
    const pending = await db.collection(OPERATIONS).where("status", "==", "pending").limit(MAX_SCAN).get();
    const eligible = pending.docs.filter(doc => {
      const operation = doc.data() || {};
      return !(operation.claim?.expiresAt > now()) && !(operation.nextAttemptAtMs > now());
    }).slice(0, 4);
    const outcomes = await Promise.allSettled(eligible.map(doc => step(doc.id)));
    const failed = outcomes.filter(outcome => outcome.status === "rejected").length;
    return {checked: pending.docs.length, processed: outcomes.length, failed};
  }

  async function step(operationId) {
    const operationRef = db.collection(OPERATIONS).doc(operationId);
    const claimId = randomUUID();
    const operation = await db.runTransaction(async tx => {
      const snapshot = await tx.get(operationRef);
      const value = snapshot.data();
      if (!value || value.status !== "pending" || value.claim?.expiresAt > now() || value.nextAttemptAtMs > now()) return null;
      tx.update(operationRef, {claim: {id: claimId, expiresAt: now() + CLAIM_MS},
        attempts: Number(value.attempts || 0) + 1, updatedAtMs: now()});
      return {...value, operationId};
    });
    if (!operation) return {claimed: false};
    try {
      if (operation.phase === "restore") {
        const restoreStartedAtMs = now();
        const receipt = await backup.restoreSnapshot(operation.descriptor, {
          snapshotName: operation.snapshotName,
          diskName: operation.targetDiskName,
          sizeGb: operation.targetSizeGb || undefined,
          operationId,
        });
        await commit(operationRef, claimId, operation, {
          phase: "verify", restoreReceipt: receipt, restoreStartedAtMs, lastError: null,
        });
        return {claimed: true, phase: "verify"};
      }
      if (operation.phase === "verify") {
        const evidence = await restoreRuntime.verify(operation.restoreReceipt, {
          operationId, workspaceId: operation.workspaceId, ownerUid: operation.ownerUid,
          descriptor: operation.descriptor, backupRecord: operation.backupRecord,
        });
        const report = recoveryReport(operation, evidence, now());
        if (!report.passed) {
          await db.collection(REPORTS).doc(operation.workspaceId).collection("reports").doc(operationId).set(report);
          try {
            const cleanup = await cleanupTarget(operation, report.failureCode);
            const cleanedReport = {...report, cleanup};
            await db.collection(REPORTS).doc(operation.workspaceId).collection("reports").doc(operationId).set(cleanedReport);
            await commit(operationRef, claimId, operation, {phase: "failed", status: "failed",
              verification: cleanedReport, cleanup, completedAtMs: now(), lastError: report.failureCode});
            return {claimed: true, passed: false, failureCode: report.failureCode, cleaned: true};
          } catch (error) {
            const pendingReport = {...report, cleanup: {state: "pending", failureCode: safeErrorCode(error)}};
            await db.collection(REPORTS).doc(operation.workspaceId).collection("reports").doc(operationId).set(pendingReport);
            await commit(operationRef, claimId, operation, {phase: "cleanup", status: "pending",
              verification: pendingReport, nextAttemptAtMs: now() + RETRY_MS, lastError: safeErrorCode(error)});
            return {claimed: true, passed: false, failureCode: report.failureCode, cleanupPending: true};
          }
        }
        await db.collection(REPORTS).doc(operation.workspaceId).collection("reports").doc(operationId).set(report);
        const verifiedReceipt = markRestoreVerified(operation.restoreReceipt, {
          workspaceId: operation.workspaceId, ownerUid: operation.ownerUid, operationId,
          verifiedAt: report.verifiedAt, runtimeReady: evidence.runtimeReady,
          fileDigest: evidence.fileDigest, diskId: evidence.diskId,
        });
        await commit(operationRef, claimId, operation, {phase: "complete", status: "succeeded",
          restoreReceipt: verifiedReceipt, verification: report, completedAtMs: now(), lastError: null});
        return {claimed: true, passed: true, report};
      }
      if (operation.phase === "cleanup") {
        const cleanup = await cleanupTarget(operation, operation.verification?.failureCode || "vm_restore_verification_failed");
        const report = {...(operation.verification || {}), cleanup};
        await db.collection(REPORTS).doc(operation.workspaceId).collection("reports").doc(operationId).set(report);
        await commit(operationRef, claimId, operation, {phase: "failed", status: "failed",
          verification: report, cleanup, nextAttemptAtMs: null, completedAtMs: now(),
          lastError: report.failureCode || "vm_restore_verification_failed"});
        return {claimed: true, passed: false, cleaned: true, failureCode: report.failureCode};
      }
      throw recoveryError("vm_restore_operation_phase_invalid");
    } catch (error) {
      await releaseForRetry(operationRef, claimId, error);
      logger.warn?.("VM backup restore retry scheduled", {operationId, errorCode: safeErrorCode(error)});
      return {claimed: true, retry: true, errorCode: safeErrorCode(error)};
    }
  }

  async function commit(ref, claimId, operation, fields) {
    return db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.claim?.id !== claimId || current.phase !== operation.phase) throw recoveryError("vm_restore_worker_claim_lost");
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

  async function cleanupTarget(operation, failureCode) {
    const result = await restoreRuntime.cleanup(operation.restoreReceipt, {
      operationId: operation.operationId, workspaceId: operation.workspaceId, ownerUid: operation.ownerUid,
      descriptor: operation.descriptor, backupRecord: operation.backupRecord, failureCode,
    });
    if (!result || result.instanceDeleted !== true || result.diskDeleted !== true) {
      throw recoveryError("vm_restore_cleanup_unconfirmed");
    }
    return {state: "complete", instanceDeleted: true, diskDeleted: true,
      timingsMs: boundedTimings(result.timingsMs)};
  }
}

function recoveryReport(operation, evidence = {}, observedAtMs) {
  const capturedAtMs = Date.parse(operation.backupRecord?.capturedAt || "");
  const requestedAtMs = Number(operation.createdAtMs);
  const restoreStartedAtMs = Number(operation.restoreStartedAtMs || requestedAtMs);
  const verifiedAt = new Date(observedAtMs).toISOString();
  const rpoMs = Number.isFinite(capturedAtMs) ? Math.max(0, requestedAtMs - capturedAtMs) : null;
  const rtoMs = Number.isFinite(restoreStartedAtMs) ? Math.max(0, observedAtMs - restoreStartedAtMs) : null;
  const target = operation.backupRecord?.recoveryTargets || backupPolicy();
  const rpoTargetMs = Number(target.rpoMs || target.rpoTargetMs || DEFAULT_RPO_TARGET_MS);
  const rtoTargetMs = Number(target.rtoMs || target.rtoTargetMs || DEFAULT_RTO_TARGET_MS);
  const expectedFileDigest = operation.backupRecord?.verification?.fileDigest;
  const expectedRuntimeStateDigest = operation.backupRecord?.verification?.runtimeStateDigest;
  const fileDigestMatch = typeof evidence.fileDigest === "string" &&
    (!expectedFileDigest || evidence.fileDigest === expectedFileDigest);
  const runtimeStateMatch = typeof evidence.runtimeStateDigest === "string" &&
    (!expectedRuntimeStateDigest || evidence.runtimeStateDigest === expectedRuntimeStateDigest);
  const failureCode = !evidence.runtimeReady ? "vm_restore_runtime_not_ready" :
    !fileDigestMatch ? "vm_restore_file_digest_mismatch" :
    !runtimeStateMatch ? "vm_restore_runtime_state_mismatch" :
    rpoMs === null || rpoMs > rpoTargetMs ? "vm_restore_rpo_target_exceeded" :
    rtoMs === null || rtoMs > rtoTargetMs ? "vm_restore_rto_target_exceeded" : null;
  return {
    version: 1,
    kind: "compute-engine-recovery-report",
    workspaceId: operation.workspaceId,
    ownerUid: operation.ownerUid,
    operationId: operation.operationId,
    backupId: operation.backupId,
    sourceGeneration: operation.sourceGeneration,
    targetDisk: operation.targetDiskName,
    verifiedAt,
    runtimeReady: evidence.runtimeReady === true,
    fileDigest: evidence.fileDigest || null,
    runtimeStateDigest: evidence.runtimeStateDigest || null,
    startupStageTimingsMs: boundedTimings(evidence.startupStageTimingsMs),
    rpoMs,
    rtoMs,
    rpoTargetMs,
    rtoTargetMs,
    rpoWithinTarget: rpoMs !== null && rpoMs <= rpoTargetMs,
    rtoWithinTarget: rtoMs !== null && rtoMs <= rtoTargetMs,
    cleanup: null,
    passed: !failureCode,
    failureCode,
  };
}

function assertRuntime(runtime, workspaceId, ownerUid, expectedGeneration) {
  if (runtime.ownerUid !== ownerUid || runtime.backend !== COMPUTE_ENGINE_BACKEND || runtime.lifecycleEnabled !== true) {
    throw recoveryError("vm_restore_runtime_not_admitted");
  }
  if (runtime.backupPolicy?.enabled !== true) throw recoveryError("vm_restore_policy_not_enabled");
  if (expectedGeneration !== undefined && Number(runtime.generation) !== Number(expectedGeneration)) {
    throw recoveryError("vm_restore_generation_mismatch");
  }
  if (!workspaceId) throw recoveryError("vm_restore_workspace_invalid");
}

function assertBackupRecord(record, workspaceId, ownerUid, backupId) {
  if (!record || record.workspaceId !== workspaceId || record.ownerUid !== ownerUid ||
      record.state !== "verified" || record.verification?.state !== "verified" ||
      !identity(backupId)) throw recoveryError("vm_restore_backup_not_verified");
  if (record.migrationInProgress === true || record.migrationOperationId) throw recoveryError("vm_restore_migration_in_progress");
  if (!record.name) throw recoveryError("vm_restore_snapshot_identity_missing");
}

function safeDiskName(value) {
  const name = String(value || "").trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw recoveryError("vm_restore_target_disk_invalid");
  return name;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw recoveryError(`vm_restore_${label}_invalid`);
  return number;
}

function identity(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) throw recoveryError("vm_restore_identity_invalid");
  return normalized;
}

function hashId(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function boundedTimings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) &&
    Number.isSafeInteger(Number(item)) && Number(item) >= 0 && Number(item) <= 24 * 60 * 60 * 1000).slice(0, 32));
}

function recoveryError(code) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  return error;
}

function safeErrorCode(error) {
  return String(error?.publicMessage || error?.code || error?.message || "vm_restore_failed").slice(0, 120);
}

module.exports = {BACKUPS, CLAIM_MS, OPERATIONS, REPORTS, createVmBackupRecoveryService, recoveryReport};
