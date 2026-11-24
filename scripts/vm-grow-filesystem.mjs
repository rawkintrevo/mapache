#!/usr/bin/env node
import {execFile} from "node:child_process";
import {createRequire} from "node:module";
import {promisify} from "node:util";

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const PROJECT_ID = "pi-agents-cloud";
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const REMOTE_HELPER = "/opt/mapache-maintenance/scripts/vm-grow-filesystem-remote.mjs";

export function parseArgs(argv = []) {
  const values = {project: PROJECT_ID, confirmGrow: false};
  const seen = new Set();
  const aliases = new Map([
    ["project", "project"], ["workspace", "workspace"], ["owner", "owner"],
    ["generation", "generation"], ["size-gb", "sizeGb"],
    ["maintenance-instance", "maintenanceInstance"], ["maintenance-id", "maintenanceId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === "--confirm-grow") {
      if (seen.has("confirmGrow")) throw new Error("duplicate --confirm-grow");
      seen.add("confirmGrow");
      values.confirmGrow = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const rawKey = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const key = aliases.get(rawKey);
    if (!key) throw new Error(`unsupported option: --${rawKey}`);
    if (seen.has(key)) throw new Error(`duplicate --${rawKey}`);
    seen.add(key);
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (value === undefined || String(value).startsWith("--")) throw new Error(`missing or duplicate value for --${rawKey}`);
    values[key] = String(value);
  }
  if (values.project !== PROJECT_ID) throw new Error(`project must be ${PROJECT_ID}`);
  for (const key of ["workspace", "owner", "maintenanceInstance", "maintenanceId"]) {
    if (!SAFE_ID.test(String(values[key] || ""))) throw new Error(`${key} is invalid`);
  }
  const generation = Number(values.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("generation is invalid");
  const sizeGb = Number(values.sizeGb);
  if (!Number.isSafeInteger(sizeGb) || sizeGb < 10 || sizeGb > 4096) throw new Error("size-gb is invalid");
  if (!/^[1-9][0-9]{0,19}$/.test(values.maintenanceId)) throw new Error("maintenance-id is invalid");
  if (!values.confirmGrow) throw new Error("--confirm-grow is required");
  return {...values, generation, sizeGb};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const admin = require("../functions/node_modules/firebase-admin");
  const {createComputeEngineService} = require("../functions/computeEngine.service.js");
  const {COMPUTE_ENGINE_BACKEND, normalizeRuntimeDescriptor, workspaceDiskName} = require("../functions/runtimeProvider.helpers.js");
  const app = admin.initializeApp({projectId: PROJECT_ID}, "vm-grow-filesystem");
  const timings = {};
  const startedAt = Date.now();
  let attached = false;
  let detachZone = null;
  let attachedDiskName = null;
  let descriptorForDetach = null;
  let compute = null;
  let result = null;
  try {
    const db = app.firestore();
    const runtimeRef = db.collection("vmRuntimes_v2").doc(options.workspace);
    const runtimeSnapshot = await runtimeRef.get();
    if (!runtimeSnapshot.exists) throw coded("vm_filesystem_growth_runtime_missing");
    const runtime = runtimeSnapshot.data() || {};
    if (runtime.ownerUid !== options.owner) throw coded("vm_filesystem_growth_owner_mismatch");
    if (runtime.backend !== COMPUTE_ENGINE_BACKEND) throw coded("vm_filesystem_growth_backend_unsupported");
    if (runtime.generation !== options.generation) throw coded("vm_filesystem_growth_generation_mismatch");
    if (runtime.state !== "stopped") throw coded("vm_filesystem_growth_runtime_not_stopped");
    if (runtime.activeOperationId) throw coded("vm_filesystem_growth_operation_in_progress");
    if (await db.collection("vmMigrationFences_v2").doc(options.workspace).get().then(snapshot => snapshot.exists)) {
      throw coded("vm_filesystem_growth_migration_in_progress");
    }
    await assertNoBackupOperations(db, options.workspace);
    const descriptor = normalizeRuntimeDescriptor(runtime.runtimeProvider || runtime.runtimeProviderDescriptor,
      {workspaceId: options.workspace, ownerUid: options.owner});
    if (descriptor.generation !== options.generation || descriptor.backend !== COMPUTE_ENGINE_BACKEND ||
        descriptor.dataDiskName !== workspaceDiskName(options.workspace)) {
      throw coded("vm_filesystem_growth_descriptor_mismatch");
    }
    compute = createComputeEngineService({projectId: PROJECT_ID});
    descriptorForDetach = descriptor;
    detachZone = descriptor.zone;
    attachedDiskName = descriptor.dataDiskName;
    const observed = await compute.inspect(descriptor);
    if (!observed.disk || observed.disk.status !== "READY" || observed.disk.users.length) {
      throw coded("vm_filesystem_growth_disk_not_detached");
    }
    if (observed.disk.sizeGb < options.sizeGb) throw coded("vm_filesystem_growth_provider_capacity_missing");

    const maintenance = await describeMaintenance(options, descriptor.zone);
    if (String(maintenance.id) !== options.maintenanceId || maintenance.status !== "RUNNING" ||
        !Array.isArray(maintenance.networkInterfaces) || maintenance.networkInterfaces.length !== 1 ||
        maintenance.networkInterfaces[0].accessConfigs?.length || maintenance.networkInterfaces[0].ipv6AccessConfigs?.length) {
      throw coded("vm_filesystem_growth_maintenance_unverified");
    }
    const attachStartedAt = Date.now();
    await run("gcloud", ["compute", "instances", "attach-disk", options.maintenanceInstance,
      "--disk", descriptor.dataDiskName, "--device-name", descriptor.dataDiskName, "--mode", "rw",
      "--zone", descriptor.zone, "--project", PROJECT_ID, "--quiet"], {timeout: 120000, maxBuffer: 64 * 1024});
    attached = true;
    timings.attach = Date.now() - attachStartedAt;
    const remoteStartedAt = Date.now();
    const remote = await runWithInput("gcloud", ["compute", "ssh", options.maintenanceInstance,
      "--zone", descriptor.zone, "--project", PROJECT_ID, "--tunnel-through-iap",
      "--strict-host-key-checking=yes", "--ssh-flag=-oBatchMode=yes",
      `--command=sudo -n node ${REMOTE_HELPER}`], {
      projectId: PROJECT_ID, workspaceId: options.workspace, ownerUid: options.owner,
      generation: options.generation, diskName: descriptor.dataDiskName, expectedSizeGb: options.sizeGb,
      maintenanceId: options.maintenanceId, zone: descriptor.zone,
    });
    timings.remote = Date.now() - remoteStartedAt;
    const evidence = parseRemoteEvidence(remote.stdout);
    if (evidence.diskName !== descriptor.dataDiskName) throw coded("vm_filesystem_growth_evidence_disk_mismatch");
    result = {projectId: PROJECT_ID, workspaceId: options.workspace, generation: options.generation,
      diskName: descriptor.dataDiskName, evidence: {...evidence, timingsMs: {...evidence.timingsMs, operatorAttach: timings.attach,
        operatorRemote: timings.remote, totalBeforeDetach: Date.now() - startedAt}}};
  } finally {
    if (attached && detachZone && attachedDiskName) {
      const detachStartedAt = Date.now();
      await run("gcloud", ["compute", "instances", "detach-disk", options.maintenanceInstance,
        "--disk", `projects/${PROJECT_ID}/zones/${detachZone}/disks/${attachedDiskName}`,
        "--zone", detachZone, "--project", PROJECT_ID, "--quiet"], {timeout: 120000, maxBuffer: 64 * 1024})
        .then(() => { timings.detach = Date.now() - detachStartedAt; });
      const detached = await compute.inspect(descriptorForDetach);
      if (!detached.disk || detached.disk.users.length) throw coded("vm_filesystem_growth_detach_unconfirmed");
    }
    await app.delete();
  }
  if (result) {
    result.evidence.timingsMs.detach = timings.detach || null;
    result.evidence.timingsMs.total = Date.now() - startedAt;
    returnJson(result);
  }
}

async function assertNoBackupOperations(db, workspaceId) {
  for (const collection of ["vmBackupOperations_v2", "vmBackupRecoveryOperations_v2"]) {
    const snapshots = await db.collection(collection).where("workspaceId", "==", workspaceId).limit(100).get();
    if (snapshots.docs.some(snapshot => !["succeeded", "failed", "deleted", "complete"].includes(snapshot.data()?.status))) {
      throw coded("vm_filesystem_growth_backup_operation_in_progress");
    }
  }
}

async function describeMaintenance(options, zone) {
  const result = await run("gcloud", ["compute", "instances", "describe", options.maintenanceInstance,
    "--zone", zone, "--project", PROJECT_ID, "--format=json"], {timeout: 120000, maxBuffer: 256 * 1024});
  try { return JSON.parse(result.stdout); } catch { throw coded("vm_filesystem_growth_maintenance_unverified"); }
}

async function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {timeout: 30 * 60 * 1000, maxBuffer: 128 * 1024}, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve({stdout, stderr});
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

function parseRemoteEvidence(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  try {
    const value = JSON.parse(lines.at(-1) || "");
    if (!value || value.diskName === undefined || value.filesystem?.type !== "ext4") throw new Error();
    return value;
  } catch { throw coded("vm_filesystem_growth_evidence_invalid"); }
}

function returnJson(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function coded(code) { const error = new Error(code); error.code = code; return error; }
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const code = String(error?.code || error?.message || "vm_filesystem_growth_failed").slice(0, 120);
    process.stderr.write(`${JSON.stringify({error: code})}\n`);
    process.exitCode = 1;
  });
}
