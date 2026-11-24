#!/usr/bin/env node
import {createHash, randomBytes} from "node:crypto";
import {execFile} from "node:child_process";
import {createRequire} from "node:module";
import {promisify} from "node:util";

const require = createRequire(import.meta.url);
const run = promisify(execFile);
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
  const {COMPUTE_ENGINE_BACKEND, normalizeRuntimeDescriptor} = require("../functions/runtimeProvider.helpers.js");
  const app = admin.initializeApp({projectId: PROJECT_ID}, "vm-backup-recovery-proof");
  const db = app.firestore();
  const backup = createComputeEngineBackupService({projectId: PROJECT_ID});
  const compute = createComputeEngineService({projectId: PROJECT_ID});
  const startedAtMs = Date.now();
  const operationId = createHash("sha256").update(`${options.workspace}:backup-recovery:${options.backup}`).digest("hex");
  const sessionId = `recovery-${operationId.slice(0, 24)}`;
  const shutdownToken = randomBytes(32).toString("hex");
  let target;
  let targetStarted = false;
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
    const receipt = await backup.restoreSnapshot(source, {snapshotName: record.name,
      diskName: targetDiskName, operationId});
    const providerRestoreMs = Date.now() - restoreStartedAtMs;
    const digestExpected = record.verification?.fileDigest;
    const sessionSecret = randomBytes(32).toString("hex");
    const startStartedAtMs = Date.now();
    await compute.start(target, {
      operationId,
      runnerImage: options.runnerImage,
      allowCreateDisk: false,
      subnetwork: SUBNETWORK,
      timeoutMs: Math.min(options.timeoutMs, 10 * 60 * 1000),
      env: {
        MAPACHE_AGENT_UI_VERSION: "pi-web-ui-v1",
        MAPACHE_PI_MODEL_CATALOG_REFRESH: "false",
        RUNNER_CAPABILITIES: JSON.stringify({terminal: true, preview: true, previewQa: true, functions: true, chrome: true}),
        SESSION_ID: sessionId,
        SESSION_BROWSER_TOKEN_SECRET: sessionSecret,
        SESSION_SHUTDOWN_TOKEN: shutdownToken,
      },
    });
    targetStarted = true;
    const computeStartMs = Date.now() - startStartedAtMs;
    const healthStartedAtMs = Date.now();
    const remote = await remoteEvidence(target, sessionId, shutdownToken, options.timeoutMs - (Date.now() - startedAtMs));
    const runnerHealthMs = Date.now() - healthStartedAtMs;
    const observedAtMs = Date.now();
    const rpoMs = Math.max(0, startedAtMs - Date.parse(record.capturedAt || ""));
    const rtoMs = observedAtMs - restoreStartedAtMs;
    const rpoTargetMs = Number(record.recoveryTargets?.rpoMs || record.recoveryTargets?.rpoTargetMs || 24 * 60 * 60 * 1000);
    const rtoTargetMs = Number(record.recoveryTargets?.rtoMs || record.recoveryTargets?.rtoTargetMs || 60 * 60 * 1000);
    const fileDigestMatch = DIGEST.test(String(digestExpected || "")) && digestExpected === remote.fileDigest;
    const sourceDigestCompared = DIGEST.test(String(digestExpected || ""));
    const failureCode = !sourceDigestCompared ? "recovery_source_file_digest_missing" :
      !fileDigestMatch ? "recovery_file_digest_mismatch" :
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
      targetDisk: target.dataDiskName,
      targetInstance: target.instanceName,
      restoreReceipt: {state: receipt.state, targetDisk: receipt.targetDisk, targetZone: receipt.targetZone},
      runtimeReady: remote.runtimeReady,
      fileDigest: remote.fileDigest,
      runtimeStateDigest: runtimeStateDigest(remote.health),
      sourceDigestCompared,
      startupStageTimingsMs: {providerRestore: providerRestoreMs, computeStart: computeStartMs,
        runnerHealth: runnerHealthMs, total: observedAtMs - startedAtMs},
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
    if (target) {
      try {
        const observed = await compute.inspect(target);
        if (targetStarted || observed.instance) await compute.deleteOwnedInstance(target, {operationId, timeoutMs: 240000});
        const detached = await compute.inspect(target);
        if (!detached.instance && detached.disk && detached.disk.users.length === 0) {
          await deleteDisk(target);
          const removed = await compute.inspect(target);
          if (removed.disk || removed.instance) throw recoveryError("recovery_cleanup_pending");
        } else if (detached.disk || detached.instance) {
          throw recoveryError("recovery_cleanup_not_safe");
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    await app.delete();
    if (cleanupError) throw cleanupError;
  }
}

async function remoteEvidence(descriptor, sessionId, shutdownToken, timeoutMs) {
  const attempts = Math.max(1, Math.min(180, Math.ceil(Math.max(30_000, timeoutMs) / 5_000)));
  const token = shellQuote(shutdownToken);
  const command = [
    "set -eu",
    `TOKEN=${token}`,
    `for attempt in $(seq 1 ${attempts}); do`,
    "health=$(curl -fsS --max-time 10 -H \"x-shutdown-token: $TOKEN\" http://127.0.0.1:8080/runner/health 2>/dev/null) || { sleep 5; continue; }",
    "digest=$(curl -fsS --max-time 30 -H \"x-shutdown-token: $TOKEN\" http://127.0.0.1:8080/runner/recovery-digest 2>/dev/null) || { sleep 5; continue; }",
    "printf 'MAPACHE_HEALTH %s\\nMAPACHE_DIGEST %s\\n' \"$health\" \"$digest\"",
    "exit 0",
    "done",
    "exit 42",
  ].join("\n");
  const result = await run("gcloud", ["compute", "ssh", descriptor.instanceName, "--project", PROJECT_ID,
    "--zone", descriptor.zone, "--tunnel-through-iap", "--strict-host-key-checking=no", "--quiet", "--command", command],
  {encoding: "utf8", maxBuffer: 2 * 1024 * 1024});
  return parseRemoteEvidence(result.stdout, {workspaceId: descriptor.workspaceId, sessionId});
}

async function deleteDisk(descriptor) {
  await run("gcloud", ["compute", "disks", "delete", descriptor.dataDiskName, "--project", PROJECT_ID,
    "--zone", descriptor.zone, "--quiet"], {encoding: "utf8", maxBuffer: 256 * 1024});
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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
