#!/usr/bin/env node
import {createHash, randomBytes} from "node:crypto";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const PROJECT_ID = "pi-agents-cloud";
const SUBNETWORK = "regions/us-central1/subnetworks/mapache-vm-v2-us-central1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUNNER_IMAGE = /^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function parseArgs(argv = []) {
  const values = {project: PROJECT_ID, timeoutMs: DEFAULT_TIMEOUT_MS, confirmRecovery: false};
  const aliases = new Map([
    ["project", "project"], ["workspace", "workspace"], ["owner", "owner"],
    ["backup", "backup"], ["runner-image", "runnerImage"], ["timeout-ms", "timeoutMs"],
    ["gateway-host", "gatewayHost"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === "--confirm-recovery") {
      if (seen.has("confirmRecovery")) throw Error("duplicate --confirm-recovery");
      seen.add("confirmRecovery");
      values.confirmRecovery = true;
      continue;
    }
    if (!argument.startsWith("--")) throw Error(`unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const rawKey = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const key = aliases.get(rawKey);
    if (!key || seen.has(key)) throw Error(`unsupported or duplicate option: --${rawKey}`);
    seen.add(key);
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (value === undefined || String(value).startsWith("--")) throw Error(`missing value for --${rawKey}`);
    values[key] = String(value);
  }
  if (values.project !== PROJECT_ID || !values.confirmRecovery) throw Error("recovery_confirmation_required");
  for (const key of ["workspace", "owner", "backup"]) {
    if (!IDENTIFIER.test(String(values[key] || ""))) throw Error(`${key}_invalid`);
  }
  if (!RUNNER_IMAGE.test(String(values.runnerImage || ""))) throw Error("runner_image_invalid");
  const timeoutMs = Number(values.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 30 * 60 * 1000) {
    throw Error("timeout_ms_invalid");
  }
  return {...values, timeoutMs};
}

export function recoveryDescriptor({workspaceId, ownerUid, sourceGeneration, region, zone, diskName, operationId}) {
  const {createRuntimeDescriptor} = require("../functions/runtimeProvider.helpers.js");
  const suffix = createHash("sha256").update(`${workspaceId}:${operationId}`).digest("hex").slice(0, 24);
  return createRuntimeDescriptor({backend: "compute-engine", workspaceId, ownerUid,
    region, zone, generation: sourceGeneration, dataDiskName: diskName,
    instanceName: `mapache-restore-${suffix}`});
}

export function parseRemoteEvidence(output, {workspaceId, sessionId} = {}) {
  const lines = String(output || "").split(/\r?\n/);
  const healthLine = lines.find(line => line.startsWith("MAPACHE_HEALTH "));
  const digestLine = lines.find(line => line.startsWith("MAPACHE_DIGEST "));
  if (!healthLine || !digestLine) throw Error("recovery_remote_evidence_missing");
  let health;
  let digest;
  try {
    health = JSON.parse(healthLine.slice("MAPACHE_HEALTH ".length));
    digest = JSON.parse(digestLine.slice("MAPACHE_DIGEST ".length));
  } catch {
    throw Error("recovery_remote_evidence_invalid");
  }
  if (health.workspaceId !== workspaceId || health.sessionId !== sessionId ||
      health.agentRuntime?.ready !== true || health.ok !== true) throw Error("recovery_runtime_not_ready");
  if (digest.ok !== true || digest.workspaceId !== workspaceId || digest.sessionId !== sessionId ||
      !DIGEST.test(String(digest.fileDigest || "")) || !Number.isSafeInteger(digest.entryCount) ||
      !Number.isSafeInteger(digest.byteCount)) throw Error("recovery_file_digest_invalid");
  return {health, digest, runtimeReady: true, fileDigest: digest.fileDigest};
}

export function runtimeStateDigest(health) {
  const safe = {
    ok: health?.ok === true,
    workspaceId: String(health?.workspaceId || ""),
    agentRuntime: {
      ready: health?.agentRuntime?.ready === true,
      state: String(health?.agentRuntime?.state || ""),
      health: {
        ready: health?.agentRuntime?.health?.ready === true,
        engine: String(health?.agentRuntime?.health?.engine || ""),
        packageVersion: String(health?.agentRuntime?.health?.build?.packageVersion || ""),
        upstreamCommit: String(health?.agentRuntime?.health?.build?.upstreamCommit || ""),
      },
    },
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(safe)).digest("hex")}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const admin = require("../functions/node_modules/firebase-admin");
  const {createComputeEngineBackupService} = require("../functions/computeEngineBackup.service.js");
  const {createComputeEngineService} = require("../functions/computeEngine.service.js");
  const {createVmBackupRecoveryRuntimeService} = require("../functions/vmBackupRecoveryRuntime.service.js");
  const {COMPUTE_ENGINE_BACKEND, normalizeRuntimeDescriptor} = require("../functions/runtimeProvider.helpers.js");
  const app = admin.initializeApp({projectId: PROJECT_ID}, "vm-backup-recovery-proof");
  const db = app.firestore();
  const backup = createComputeEngineBackupService({projectId: PROJECT_ID});
  const computeAuth = new (require("google-auth-library").GoogleAuth)({scopes: ["https://www.googleapis.com/auth/cloud-platform"]});
  const compute = createComputeEngineService({projectId: PROJECT_ID,
    request: async options => (await computeAuth.getClient()).request({...options, timeout: 30_000}),
  });
  const gatewayHost = String(options.gatewayHost || process.env.VM_BACKUP_RECOVERY_GATEWAY_HOST || "").trim();
  if (!gatewayHost) throw recoveryError("recovery_gateway_host_required");
  const recoveryRuntime = createVmBackupRecoveryRuntimeService({db, compute,
    gatewayHost, runnerImage: options.runnerImage});
  const startedAtMs = Date.now();
  // Compute request IDs remain idempotent after a completed operation. Each
  // disposable proof therefore needs a fresh operation identity after cleanup;
  // otherwise a rerun can receive the old insert operation instead of creating
  // its fresh VM.
  const operationId = createHash("sha256").update(`${options.workspace}:backup-recovery:${options.backup}:${randomBytes(16).toString("hex")}`).digest("hex");
  let target;
  let receipt;
  let cleanupError = null;
  try {
    const runtimeSnapshot = await db.collection("vmRuntimes_v2").doc(options.workspace).get();
    const backupSnapshot = await db.collection("vmBackups_v2").doc(options.workspace).collection("items").doc(options.backup).get();
    if (!runtimeSnapshot.exists) throw recoveryError("recovery_runtime_missing");
    if (!backupSnapshot.exists) throw recoveryError("recovery_backup_missing");
    const runtime = runtimeSnapshot.data() || {};
    const record = backupSnapshot.data() || {};
    if (runtime.ownerUid !== options.owner || runtime.backend !== COMPUTE_ENGINE_BACKEND || runtime.lifecycleEnabled !== true) {
      throw recoveryError("recovery_runtime_not_admitted");
    }
    if (runtime.backupPolicy?.enabled !== true || runtime.activeOperationId) throw recoveryError("recovery_policy_not_admitted");
    if (!record || record.workspaceId !== options.workspace || record.ownerUid !== options.owner ||
        record.state !== "verified" || record.verification?.state !== "verified" || !record.name) {
      throw recoveryError("recovery_backup_not_verified");
    }
    if (await db.collection("vmMigrationFences_v2").doc(options.workspace).get().then(snapshot => snapshot.exists)) {
      throw recoveryError("recovery_migration_in_progress");
    }
    const source = normalizeRuntimeDescriptor(runtime.runtimeProvider || runtime.runtimeProviderDescriptor,
      {workspaceId: options.workspace, ownerUid: options.owner});
    const targetDiskName = `mapache-restore-${createHash("sha256").update(`${options.workspace}:${options.backup}`).digest("hex").slice(0, 24)}`;
    target = recoveryDescriptor({workspaceId: options.workspace, ownerUid: options.owner,
      sourceGeneration: Number(record.sourceGeneration || source.generation), region: source.region, zone: source.zone,
      diskName: targetDiskName, operationId});
    const existing = await compute.inspect(target);
    if (existing.disk || existing.instance) throw recoveryError("recovery_target_exists");

    const restoreStartedAtMs = Date.now();
    receipt = await backup.restoreSnapshot(source, {snapshotName: record.name,
      diskName: targetDiskName, operationId});
    const providerRestoreMs = Date.now() - restoreStartedAtMs;
    const digestExpected = record.verification?.fileDigest;
    let runtimeEvidence;
    try {
      runtimeEvidence = await recoveryRuntime.verify(receipt, {
        operationId, workspaceId: options.workspace, ownerUid: options.owner,
        descriptor: source, backupRecord: record,
      });
    } catch (error) {
      const sessionId = `vm-backup-${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
      const failureSession = await db.collection("vmBackupRecoveryRuntimes_v2").doc(options.workspace)
          .collection("sessions").doc(sessionId).get().catch(() => null);
      process.stderr.write(`${JSON.stringify({
        recoveryError: String(error?.code || error?.message || "recovery_failed"),
        controlFailure: failureSession?.exists ? failureSession.data()?.lastError || null : null,
        controlRuntimeState: failureSession?.exists ? failureSession.data()?.runtimeState || null : null,
      })}\n`);
      throw error;
    }
    const observedAtMs = Date.now();
    const rpoMs = Math.max(0, startedAtMs - Date.parse(record.capturedAt || ""));
    const rtoMs = observedAtMs - restoreStartedAtMs;
    const rpoTargetMs = Number(record.recoveryTargets?.rpoMs || record.recoveryTargets?.rpoTargetMs || 24 * 60 * 60 * 1000);
    const rtoTargetMs = Number(record.recoveryTargets?.rtoMs || record.recoveryTargets?.rtoTargetMs || 60 * 60 * 1000);
    const runtimeDigestExpected = record.verification?.runtimeStateDigest;
    const fileDigestMatch = DIGEST.test(String(digestExpected || "")) && digestExpected === runtimeEvidence.fileDigest;
    const runtimeDigestMatch = DIGEST.test(String(runtimeDigestExpected || "")) && runtimeDigestExpected === runtimeEvidence.runtimeStateDigest;
    const sourceDigestCompared = DIGEST.test(String(digestExpected || ""));
    const sourceRuntimeDigestCompared = DIGEST.test(String(runtimeDigestExpected || ""));
    const failureCode = !runtimeEvidence.runtimeReady ? "recovery_runtime_not_ready" :
      !sourceDigestCompared ? "recovery_source_file_digest_missing" :
      !sourceRuntimeDigestCompared ? "recovery_source_runtime_digest_missing" :
      !fileDigestMatch ? "recovery_file_digest_mismatch" :
      !runtimeDigestMatch ? "recovery_runtime_state_mismatch" :
      rpoMs > rpoTargetMs ? "recovery_rpo_target_exceeded" : rtoMs > rtoTargetMs ? "recovery_rto_target_exceeded" : null;
    const result = {
      version: 1,
      kind: "compute-engine-backup-recovery-proof",
      projectId: PROJECT_ID,
      workspaceId: options.workspace,
      ownerUid: options.owner,
      backupId: options.backup,
      operationId,
      sourceGeneration: Number(record.sourceGeneration || source.generation),
      targetDisk: receipt.targetDisk,
      targetInstance: `mapache-recovery-vm-${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`,
      restoreReceipt: {state: receipt.state, targetDisk: receipt.targetDisk, targetZone: receipt.targetZone},
      runtimeReady: runtimeEvidence.runtimeReady,
      fileDigest: runtimeEvidence.fileDigest,
      runtimeStateDigest: runtimeEvidence.runtimeStateDigest,
      sourceDigestCompared,
      sourceRuntimeDigestCompared,
      startupStageTimingsMs: {providerRestore: providerRestoreMs, ...runtimeEvidence.startupStageTimingsMs,
        total: observedAtMs - startedAtMs},
      rpoMs,
      rtoMs,
      rpoTargetMs,
      rtoTargetMs,
      rpoWithinTarget: rpoMs <= rpoTargetMs,
      rtoWithinTarget: rtoMs <= rtoTargetMs,
      passed: failureCode === null,
      failureCode,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (failureCode) process.exitCode = 2;
  } finally {
    if (receipt) {
      try {
        await recoveryRuntime.cleanup(receipt, {
          operationId, workspaceId: options.workspace, ownerUid: options.owner,
          descriptor: target, backupRecord: undefined,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    await app.delete();
    if (cleanupError) throw cleanupError;
  }
}

function recoveryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const code = String(error?.code || error?.message || "recovery_failed").replace(/[^a-z0-9_:-]/gi, "_").slice(0, 120);
    process.stderr.write(`${JSON.stringify({error: code, sourceRetained: true})}\n`);
    process.exitCode = process.exitCode || 1;
  });
}
