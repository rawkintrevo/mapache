import {execFile} from "node:child_process";
import {createRequire} from "node:module";
import {promisify} from "node:util";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {verifyHubspotBackup} from "./import.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const {createAgentCheckpointService} = require("../../../session-runner/lib/agentCheckpoint.service.js");
const {createAgentSnapshotService} = require("../../../session-runner/lib/agentSnapshot.service.js");

export const CUTOVER_CONFIRMATION = "pi-web-ui-hubspot-cutover-v1";
export const AGENT_UI_VERSION = "pi-web-ui-v1";
export const AGENT_IMAGE_KEY = "pi-chrome";

const WORKSPACE_PREFIX = "workspace/";
const HISTORY_PREFIX = "sessions/";
const ATTACHMENT_PREFIX = "attachments/";
const IMPORT_RECEIPT = ".mapache-hubspot-import.json";

/**
 * Build the migration-only checkpoint from the already verified Task 24
 * state roots. This intentionally does not read the legacy home archive or
 * browser profile: only the backup-derived workspace and selected histories
 * enter the new checkpoint namespace.
 */
export async function prepareCutover({
  backupRoot,
  stateRoot,
  ownerUid,
  workspaceId,
  sessionId,
  sourcePrefix,
  fsImpl = fs,
} = {}) {
  const verified = await verifyHubspotBackup({backupRoot, fsImpl});
  assertSource(verified.manifest.source, {ownerUid, workspaceId, sessionId, sourcePrefix});
  const roots = resolveStateRoots(stateRoot);
  const state = await verifyImportedState({fsImpl, roots, verified});
  return {
    backup: {
      root: verified.backupRoot,
      manifestSha256: verified.manifestSha256,
      copied: verified.counts.copied,
      skipped: verified.counts.skipped,
      historyFiles: verified.counts.historyFiles,
      historyRecords: verified.counts.historyRecords,
      trailingIncomplete: verified.counts.trailingIncomplete,
    },
    source: verified.manifest.source,
    roots,
    state,
  };
}

/**
 * Perform one guarded cut-over. The source documents are snapshotted before
 * mutation and restored if publication or provisioning fails. Immutable
 * orphan objects are retained for diagnosis; no mutable source object is
 * deleted or rewritten.
 */
export async function executeCutover({
  backupRoot,
  stateRoot,
  ownerUid,
  workspaceId,
  sessionId,
  sourcePrefix,
  bucketName,
  image,
  generation = 1,
  bootInstanceId,
  operationId,
  stagingRoot,
  project = "pi-agents-cloud",
  confirmation,
  reportPath,
  fsImpl = fs,
} = {}) {
  if (confirmation !== CUTOVER_CONFIRMATION) throw cutoverError("confirmation_required", `--confirm=${CUTOVER_CONFIRMATION} is required`);
  const cleanImage = requireDigestImage(image);
  const cleanGeneration = requirePositiveInteger(generation, "generation");
  const cleanBoot = requireSafeSegment(bootInstanceId, "boot instance ID");
  const cleanOperation = requireSafeSegment(operationId, "operation ID");
  const prepared = await prepareCutover({
    backupRoot,
    stateRoot,
    ownerUid,
    workspaceId,
    sessionId,
    sourcePrefix,
    fsImpl,
  });
  const {admin, db, storage} = require("../../../functions/backendContext.js");
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  const sessionRef = workspaceRef.collection("sessions").doc(sessionId);
  const before = await readSourceState({workspaceRef, sessionRef});
  await assertRemotePreconditions({
    before,
    bucketName,
    project,
    sourcePrefix,
    ownerUid,
    workspaceId,
    sessionId,
  });

  let migrationMutated = false;
  let serviceStarted = false;
  try {
    await armMigrationAuthority({
      admin,
      db,
      image: cleanImage,
      generation: cleanGeneration,
      bootInstanceId: cleanBoot,
      operationId: cleanOperation,
      ownerUid,
      workspaceId,
      sessionId,
      bucketName,
      sourcePrefix,
    });
    migrationMutated = true;

    const config = {
      agentRuntimeEnabled: true,
      agentUiVersion: AGENT_UI_VERSION,
      agentRuntimeGeneration: cleanGeneration,
      agentRuntimeBootInstanceId: cleanBoot,
      bucketName,
      prefix: sourcePrefix,
      workspaceId,
      sessionId,
      workspaceDir: prepared.roots.workspace,
      piSessionDir: prepared.roots.sessions,
      piAgentDir: prepared.roots.pi,
      piWebUiDataDir: prepared.roots.ui,
      agentStateRoot: stagingRoot || path.join(os.tmpdir(), `mapache-hubspot-cutover-${cleanOperation}`),
    };
    const snapshotService = createAgentSnapshotService({config, fsImpl});
    const capture = await snapshotService.capture({
      bootInstanceId: cleanBoot,
      generation: cleanGeneration,
      sessionId,
      stagingRoot: config.agentStateRoot,
      workspaceId,
    });
    const checkpointService = createAgentCheckpointService({admin, config, db, fsImpl, storage});
    const uploaded = await checkpointService.uploadCapture({
      ...capture,
      bucketName,
      captureId: `${cleanOperation}-agent`,
    });
    const agentPointer = await checkpointService.commitCheckpoint(uploaded);
    const workspacePointer = await checkpointService.publishWorkspaceFiles({
      sourceRoot: prepared.roots.workspace,
      generation: cleanGeneration,
      bootInstanceId: cleanBoot,
      sessionId,
      workspaceId,
      shouldIgnore: (relativePath) => relativePath === ".mapache-internal" || relativePath.startsWith(".mapache-internal/"),
    });

    await releaseMigrationAuthority({db, admin, workspaceId, sessionId, generation: cleanGeneration, bootInstanceId: cleanBoot});

    const functions = require("../../../functions/index.js");
    const restarted = await functions.operations.restartSession(ownerUid, workspaceId, sessionId);
    serviceStarted = true;
    const result = {
      ok: true,
      mode: "cutover",
      project,
      backup: prepared.backup,
      source: prepared.source,
      target: {
        workspaceId,
        sessionId,
        bucketName,
        storagePrefix: sourcePrefix,
        image: cleanImage,
        migrationGeneration: cleanGeneration,
        runtimeGeneration: safeNumber(restarted.agentRuntimeGeneration),
        runtimeState: String(restarted.agentRuntimeState || ""),
        status: String(restarted.status || ""),
      },
      checkpoints: {
        agent: checkpointSummary(agentPointer),
        workspace: checkpointSummary(workspacePointer),
        sourceObjectsRetained: true,
      },
      state: prepared.state,
    };
    await writeReport(reportPath, result, fsImpl);
    return result;
  } catch (error) {
    if (migrationMutated || serviceStarted) {
      await rollbackCutover({before, db, admin, project, workspaceId, sessionId, serviceId: before.session.serviceId}).catch(() => {});
    }
    throw error;
  }
}

async function assertRemotePreconditions({before, bucketName, project, sourcePrefix, ownerUid, workspaceId, sessionId}) {
  if (before.workspace.ownerUid !== ownerUid) throw cutoverError("owner_mismatch", "source workspace owner does not match the restricted inventory");
  if (before.workspace.storagePrefix !== sourcePrefix || before.workspace.bucket !== bucketName) {
    throw cutoverError("source_storage_mapping_mismatch", "source workspace storage mapping changed");
  }
  if (before.workspace.agentUiVersion || before.workspace.agentRuntimeCheckpoint || before.workspace.agentRuntimeWorkspaceFiles) {
    throw cutoverError("cutover_already_started", "source workspace already has managed-runtime state");
  }
  if (before.session.ownerUid !== ownerUid || before.session.workspaceId !== workspaceId) {
    throw cutoverError("source_session_mapping_mismatch", "source session ownership or workspace changed");
  }
  if (before.session.status !== "stopped" || before.session.serviceUrl) {
    throw cutoverError("source_not_stopped", "source session is not confirmed stopped");
  }
  await assertCloudRunAbsent({project, region: before.session.region || "us-central1", serviceId: before.session.serviceId});
  if (before.session.imageKey !== AGENT_IMAGE_KEY || before.session.harnessId !== "pi") {
    throw cutoverError("source_session_not_pi_chrome", "restricted source session is not the selected pi-chrome session");
  }
}

async function armMigrationAuthority({admin, db, image, generation, bootInstanceId, operationId, ownerUid, workspaceId, sessionId, bucketName, sourcePrefix}) {
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  const sessionRef = workspaceRef.collection("sessions").doc(sessionId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const [workspaceSnap, sessionSnap] = await Promise.all([transaction.get(workspaceRef), transaction.get(sessionRef)]);
    if (!workspaceSnap.exists || !sessionSnap.exists) throw cutoverError("source_missing", "source workspace or session disappeared");
    const workspace = workspaceSnap.data() || {};
    const session = sessionSnap.data() || {};
    if (workspace.ownerUid !== ownerUid || workspace.storagePrefix !== sourcePrefix || workspace.bucket !== bucketName || workspace.agentUiVersion) {
      throw cutoverError("source_changed_before_cutover", "source workspace changed before cut-over transaction");
    }
    if (session.status !== "stopped" || session.serviceUrl || session.ownerUid !== ownerUid) {
      throw cutoverError("source_changed_before_cutover", "source session changed before cut-over transaction");
    }
    const common = {
      agentUiVersion: AGENT_UI_VERSION,
      agentRuntimeOperationId: operationId,
      agentRuntimeGeneration: generation,
      agentRuntimeState: "starting",
      agentRuntimeAuthorityState: "admitted",
      agentRuntimeBootInstanceId: bootInstanceId,
      agentRuntimeBootAcquiredAt: now,
      agentRuntimeBootHeartbeatAt: now,
      agentRuntimeUpdatedAt: now,
    };
    transaction.update(workspaceRef, {
      ...common,
      agentRuntimeSessionId: sessionId,
      agentRollout: {markedAt: now, markedBy: "task30-cutover", purpose: "migration"},
      updatedAt: now,
    });
    transaction.update(sessionRef, {
      ...common,
      image,
      imageKey: AGENT_IMAGE_KEY,
      harnessId: "pi",
      terminalKind: "pi",
      runnerImageDigest: image,
      runnerImageCurrentDigest: image,
      runnerImageFreshness: "fresh",
      updatedAt: now,
    });
  });
}

async function releaseMigrationAuthority({db, admin, workspaceId, sessionId, generation, bootInstanceId}) {
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  const sessionRef = workspaceRef.collection("sessions").doc(sessionId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const [workspaceSnap, sessionSnap] = await Promise.all([transaction.get(workspaceRef), transaction.get(sessionRef)]);
    const workspace = workspaceSnap.data() || {};
    const session = sessionSnap.data() || {};
    if (workspace.agentRuntimeGeneration !== generation || session.agentRuntimeGeneration !== generation ||
        workspace.agentRuntimeBootInstanceId !== bootInstanceId || session.agentRuntimeBootInstanceId !== bootInstanceId) {
      throw cutoverError("migration_authority_lost", "migration authority changed before runner start");
    }
    transaction.update(workspaceRef, {agentRuntimeAuthorityState: "released", agentRuntimeState: "stopped", agentRuntimeBootInstanceId: null, agentRuntimeUpdatedAt: now});
    transaction.update(sessionRef, {agentRuntimeAuthorityState: "released", agentRuntimeState: "stopped", agentRuntimeBootInstanceId: null, agentRuntimeUpdatedAt: now});
  });
}

async function rollbackCutover({before, db, admin, project, workspaceId, sessionId, serviceId}) {
  if (serviceId) {
    await execFileAsync("gcloud", ["run", "services", "delete", serviceId, "--region", before.session.region || "us-central1", "--project", project, "--quiet"], {maxBuffer: 1024 * 1024}).catch(() => {});
  }
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  const sessionRef = workspaceRef.collection("sessions").doc(sessionId);
  await db.runTransaction(async (transaction) => {
    transaction.set(workspaceRef, before.workspace);
    transaction.set(sessionRef, before.session);
  });
}

async function assertCloudRunAbsent({project, region, serviceId}) {
  if (!serviceId) throw cutoverError("source_service_id_missing", "source session has no Cloud Run service ID");
  try {
    await execFileAsync("gcloud", ["run", "services", "describe", serviceId, "--region", region, "--project", project], {maxBuffer: 1024 * 1024});
  } catch (error) {
    if (error?.code === 1) return;
    throw cutoverError("source_service_check_failed", "could not prove the source Cloud Run service is absent", error);
  }
  throw cutoverError("source_service_present", "source Cloud Run service is still present");
}

async function readSourceState({workspaceRef, sessionRef}) {
  const [workspaceSnap, sessionSnap] = await Promise.all([workspaceRef.get(), sessionRef.get()]);
  if (!workspaceSnap.exists || !sessionSnap.exists) throw cutoverError("source_missing", "source workspace or session does not exist");
  return {workspace: workspaceSnap.data() || {}, session: sessionSnap.data() || {}};
}

async function verifyImportedState({fsImpl, roots, verified}) {
  const expected = new Map();
  for (const record of verified.files) {
    const mapped = mapRecord(record);
    const key = `${mapped.root}/${mapped.relativePath}`;
    if (expected.has(key)) throw cutoverError("state_path_collision", `imported state has duplicate path: ${key}`);
    expected.set(key, {record, mapped});
  }
  const actual = [];
  for (const rootName of ["workspace", "sessions", "pi", "ui"]) {
    for (const entry of await collectTree(path.join(roots[rootName]), fsImpl)) actual.push(`${rootName}/${entry}`);
  }
  const allowedReceipt = `pi/${IMPORT_RECEIPT}`;
  for (const key of actual) {
    if (key !== allowedReceipt && !expected.has(key)) throw cutoverError("state_extra_file", `imported state has an unexpected file: ${key}`);
  }
  for (const [key, item] of expected) {
    const actualPath = path.join(roots[item.mapped.root], ...item.mapped.relativePath.split("/"));
    const content = await fsImpl.readFile(actualPath).catch((error) => { throw cutoverError("state_file_missing", `imported state is missing: ${key}`, error); });
    if (item.record.kind === "symlink") throw cutoverError("state_symlink_unsupported", `cut-over state contains an unsupported symlink: ${key}`);
    if (content.length !== item.record.byteLength || sha256(content) !== item.record.sha256) {
      throw cutoverError("state_checksum_mismatch", `imported state checksum differs from final backup: ${key}`);
    }
  }
  return {
    workspaceFiles: [...expected.values()].filter(({mapped}) => mapped.root === "workspace").length,
    historyFiles: [...expected.values()].filter(({mapped}) => mapped.root === "sessions").length,
    historyRecords: verified.counts.historyRecords,
    extraReceipt: actual.includes(allowedReceipt),
  };
}

async function collectTree(root, fsImpl, current = root, prefix = "") {
  const output = [];
  const entries = await fsImpl.readdir(current, {withFileTypes: true}).catch((error) => {
    if (error?.code === "ENOENT") throw cutoverError("state_root_missing", `state root is missing: ${root}`, error);
    throw error;
  });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const child = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await collectTree(root, fsImpl, child, relative));
    else output.push(relative);
  }
  return output;
}

function resolveStateRoots(stateRoot) {
  const root = path.resolve(requireValue(stateRoot, "state root"));
  return {
    workspace: path.join(root, "workspace"),
    sessions: path.join(root, "sessions"),
    pi: path.join(root, "pi"),
    ui: path.join(root, "ui"),
  };
}

function mapRecord(record) {
  const source = String(record.sourcePath || "");
  if (record.category === "workspace") {
    const relative = source.slice(WORKSPACE_PREFIX.length);
    if (relative.startsWith(".pi/agent/")) return {root: "pi", relativePath: relative.slice(".pi/agent/".length)};
    return {root: "workspace", relativePath: relative};
  }
  if (record.category === "history") {
    const sourceSessionPrefix = `${HISTORY_PREFIX}${record.sourceSessionId}/`;
    if (!source.startsWith(sourceSessionPrefix)) throw cutoverError("history_path_invalid", `history record is outside selected session: ${source}`);
    return {root: "sessions", relativePath: path.posix.basename(source.slice(sourceSessionPrefix.length))};
  }
  if (record.category === "pi") return {root: "pi", relativePath: source.slice("pi/".length)};
  if (record.category === "ui") return {root: "ui", relativePath: source.slice("ui/".length)};
  if (record.category === "attachment") return {root: "ui", relativePath: source.slice(ATTACHMENT_PREFIX.length)};
  throw cutoverError("record_category_unsupported", `unsupported migration record category: ${record.category}`);
}

function assertSource(source, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (String(source?.[key] || "").trim() !== String(value || "").trim()) throw cutoverError("source_mapping_mismatch", `backup source ${key} does not match the requested mapping`);
  }
}

function checkpointSummary(result) {
  return {
    captureId: result?.captureId || result?.pointer?.captureId || null,
    generation: safeNumber(result?.pointer?.generation),
    fileCount: safeNumber(result?.pointer?.fileCount),
    tombstoneCount: safeNumber(result?.pointer?.tombstoneCount),
    manifestObjectPath: result?.pointer?.manifest?.objectPath || result?.manifestRef?.objectPath || null,
  };
}

function requireDigestImage(value) {
  const image = String(value || "").trim();
  if (!/^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/.test(image)) {
    throw cutoverError("immutable_image_required", "cut-over requires the exact pi-chrome Artifact Registry digest");
  }
  return image;
}

function requireSafeSegment(value, label) {
  const clean = requireValue(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(clean)) throw cutoverError("unsafe_identity", `${label} contains unsupported characters`);
  return clean;
}

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw cutoverError("invalid_integer", `${label} must be a positive integer`);
  return number;
}

function requireValue(value, label) {
  const clean = String(value || "").trim();
  if (!clean) throw cutoverError("argument_missing", `${label} is required`);
  return clean;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sha256(content) {
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function writeReport(reportPath, result, fsImpl) {
  if (!reportPath) return;
  const resolved = path.resolve(reportPath);
  await fsImpl.mkdir(path.dirname(resolved), {recursive: true});
  await fsImpl.writeFile(resolved, `${JSON.stringify(result, null, 2)}\n`, {mode: 0o600});
}

function cutoverError(code, message, cause) {
  const error = new Error(message, cause ? {cause} : undefined);
  error.code = code;
  return error;
}

export function parseCutoverArgs(argv = []) {
  const args = {execute: false};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--execute") {
      args.execute = true;
      continue;
    }
    if (!token.startsWith("--")) throw cutoverError("argument_invalid", `unexpected argument: ${token}`);
    const equals = token.indexOf("=");
    const key = equals >= 0 ? token.slice(2, equals) : token.slice(2);
    const value = equals >= 0 ? token.slice(equals + 1) : argv[++index];
    if (!key || value === undefined || String(value).startsWith("--")) throw cutoverError("argument_missing", `missing value for --${key}`);
    args[key] = String(value);
  }
  return args;
}

export async function runCutoverCli(argv = process.argv.slice(2)) {
  const args = parseCutoverArgs(argv);
  const prepared = await prepareCutover({
    backupRoot: requireValue(args["backup-root"], "--backup-root"),
    stateRoot: requireValue(args["state-root"], "--state-root"),
    ownerUid: requireValue(args["owner-uid"], "--owner-uid"),
    workspaceId: requireValue(args["workspace-id"], "--workspace-id"),
    sessionId: requireValue(args["session-id"], "--session-id"),
    sourcePrefix: requireValue(args["source-prefix"], "--source-prefix"),
  });
  if (!args.execute) {
    const result = {mode: "dry-run", source: prepared.source, backup: prepared.backup, state: prepared.state, writes: "none"};
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const result = await executeCutover({
    backupRoot: args["backup-root"],
    stateRoot: args["state-root"],
    ownerUid: args["owner-uid"],
    workspaceId: args["workspace-id"],
    sessionId: args["session-id"],
    sourcePrefix: args["source-prefix"],
    bucketName: requireValue(args.bucket, "--bucket"),
    image: requireValue(args.image, "--image"),
    generation: args.generation || 1,
    bootInstanceId: requireValue(args["boot-instance-id"], "--boot-instance-id"),
    operationId: requireValue(args["operation-id"], "--operation-id"),
    stagingRoot: args["staging-root"],
    project: args.project || "pi-agents-cloud",
    confirmation: args.confirm,
    reportPath: args.report,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runCutoverCli().catch((error) => {
    process.stderr.write(`${JSON.stringify({error: error.code || "cutover_failed", message: error.message})}\n`);
    process.exitCode = 1;
  });
}
