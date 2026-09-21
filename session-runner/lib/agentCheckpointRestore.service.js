"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {agentSnapshotStoragePrefix, parseCompleteJsonl} = require("./agentSnapshot.service");
const {CHECKPOINT_VERSION, WORKSPACE_FILE_NAMESPACE, validateRelativePath} = require("./agentCheckpoint.service");
const {isSharedGcsFuseMode} = require("./sharedWorkspace.helpers");

function isAutomationRuntime(config = {}) {
  return String(config.runtimeKind || "").trim().toLowerCase() === "automation";
}

const AGENT_FILE_ROOTS = Object.freeze([
  {prefix: "sessions", kind: "pi-transcript", configKey: "piSessionDir"},
  {prefix: "pi", kind: "pi-setting", configKey: "piAgentDir"},
  {prefix: "ui", kind: "ui-state", configKey: "piWebUiDataDir"},
  {prefix: "uploads", kind: "attachment", configKey: "piWebUiDataDir", subdirectory: "uploads"},
]);

/**
 * Restores only the manifests currently published by the workspace authority.
 * Downloads and validation happen before any target is changed; installation
 * then records inverse renames so a filesystem error restores the old state.
 */
function createAgentCheckpointRestoreService({
  config = {},
  db,
  fsImpl = fs,
  randomId = () => crypto.randomUUID(),
  storage,
} = {}) {
  const enabled = config.agentRuntimeEnabled === true || config.agentUiVersion === "pi-web-ui-v1";

  return {
    enabled: () => enabled,
    hasPublishedWorkspaceFiles: async () => {
      if (!enabled) return false;
      const pointers = await readPublishedPointers({config, db});
      return Boolean(pointers.workspace);
    },
    restoreAgentState: (options = {}) => {
      if (!enabled && options.allowUnmarked !== true) return Promise.resolve({enabled: false, skipped: true});
      return restorePublishedCheckpoint({
        ...options,
        config,
        db,
        fsImpl,
        includeAgent: true,
        includeWorkspace: false,
        randomId,
        storage,
      });
    },
    restoreCheckpoint: (options = {}) => {
      if (!enabled && options.allowUnmarked !== true) return Promise.resolve({enabled: false, skipped: true});
      return restorePublishedCheckpoint({
        ...options,
        config,
        db,
        fsImpl,
        includeAgent: true,
        includeWorkspace: !isSharedGcsFuseMode(config.workspaceStorageMode),
        randomId,
        storage,
      });
    },
    restoreWorkspaceFiles: (options = {}) => {
      if (isSharedGcsFuseMode(config.workspaceStorageMode)) {
        return Promise.resolve({enabled: true, skipped: true, reason: "shared_gcsfuse_authoritative"});
      }
      if (!enabled && options.allowUnmarked !== true) return Promise.resolve({enabled: false, skipped: true});
      return restorePublishedCheckpoint({
        ...options,
        config,
        db,
        fsImpl,
        includeAgent: false,
        includeWorkspace: true,
        randomId,
        storage,
      });
    },
  };
}

async function restorePublishedCheckpoint({
  config = {},
  db,
  fsImpl = fs,
  includeAgent,
  includeWorkspace,
  randomId = () => crypto.randomUUID(),
  shouldIgnore = () => false,
  storage,
} = {}) {
  if (!includeAgent && !includeWorkspace) return {ok: true, skipped: true};
  const pointers = await readPublishedPointers({config, db});
  if (includeAgent && !pointers.agent && includeWorkspace && !pointers.workspace) {
    return {ok: true, skipped: true, reason: "no_published_checkpoint"};
  }
  if (includeAgent && !pointers.agent && !includeWorkspace) {
    return {ok: true, skipped: true, reason: "no_published_agent_checkpoint"};
  }
  if (includeWorkspace && !pointers.workspace && !includeAgent) {
    return {ok: true, skipped: true, reason: "no_published_workspace_checkpoint"};
  }

  const workspaceStage = includeWorkspace && pointers.workspace ?
    await makeStageDir(fsImpl, path.dirname(config.workspaceDir), randomId) : null;
  const agentStage = includeAgent && pointers.agent ?
    await makeStageDir(fsImpl, path.dirname(config.piSessionDir), randomId) : null;
  try {
    const workspacePlan = includeWorkspace && pointers.workspace ? await buildWorkspacePlan({
      config,
      fsImpl,
      pointer: pointers.workspace,
      shouldIgnore,
      stageDir: workspaceStage,
      storage,
    }) : null;
    const agentPlan = includeAgent && pointers.agent ? await buildAgentPlan({
      config,
      fsImpl,
      pointer: pointers.agent,
      stageDir: agentStage,
      storage,
    }) : null;

    const undo = [];
    const cleanup = [];
    try {
      if (workspacePlan) await installWorkspacePlan({cleanup, config, fsImpl, plan: workspacePlan, undo});
      if (agentPlan) await installAgentPlan({cleanup, config, fsImpl, plan: agentPlan, undo});
      return {
        ok: true,
        agent: agentPlan ? {captureId: pointers.agent.captureId, fileCount: agentPlan.files.length} : null,
        workspace: workspacePlan ? {captureId: pointers.workspace.captureId, fileCount: workspacePlan.files.length} : null,
      };
    } catch (error) {
      await rollback(undo);
      throw error;
    } finally {
      await cleanupPaths(cleanup, fsImpl);
    }
  } finally {
    await cleanupPaths([workspaceStage, agentStage].filter(Boolean), fsImpl);
  }
}

async function buildAgentPlan({config, fsImpl, pointer, stageDir, storage}) {
  const manifest = await downloadManifest({
    config,
    expectedKind: "mapache-agent-state-snapshot",
    namespace: agentSnapshotStoragePrefix(config),
    pointer,
    storage,
  });
  validatePointerIdentity(manifest, pointer, config, "agent");
  if (pointer.fileCount !== undefined && Number(pointer.fileCount) !== manifest.files.length) {
    throw restoreError("checkpoint_manifest_invalid", "Agent checkpoint file count does not match its pointer");
  }
  const files = [];
  const seen = new Set();
  for (const entry of manifest.files || []) {
    const relativePath = validateRelativePath(entry.path, "agent snapshot file");
    if (seen.has(relativePath)) throw restoreError("checkpoint_manifest_invalid", "Agent checkpoint contains duplicate paths");
    seen.add(relativePath);
    const root = agentRootForPath(config, relativePath, entry.kind, stageDir);
    const objectPath = expectedObjectPath(pointer, manifest, relativePath, entry.kind);
    const targetPath = path.resolve(root.targetRoot, root.relativePath);
    const stagedPath = path.resolve(stageDir, root.stageRelativePath);
    assertInside(root.targetRoot, targetPath, "agent restore target");
    assertInside(stageDir, stagedPath, "agent restore staging target");
    if (entry.kind === "symlink") {
      validateSymlinkTarget(entry.target, root.stageRoot, stagedPath);
      await fsImpl.promises.mkdir(path.dirname(stagedPath), {recursive: true});
      await fsImpl.promises.symlink(entry.target, stagedPath);
      files.push({entry, relativePath, stagedPath, targetPath, symlink: true});
      continue;
    }
    if (!objectPath) throw restoreError("checkpoint_manifest_invalid", `Agent file has no object: ${relativePath}`);
    const content = await downloadObject({
      bucketName: pointer.manifest.bucketName,
      expected: entry,
      label: relativePath,
      objectPath,
      storage,
    });
    validateAgentContent(entry, content, relativePath);
    await writeStagedFile({content, fsImpl, mode: entry.mode, stagedPath});
    files.push({entry, relativePath, stagedPath, targetPath, symlink: false});
  }
  await validateStagedSymlinkTargets({files, fsImpl, stageDir});
  const stageRoots = [...new Map(AGENT_FILE_ROOTS
      .filter(({configKey}) => config[configKey])
      .map((root) => [path.resolve(config[root.configKey]), {
        stageRoot: path.resolve(stageDir, root.subdirectory ? "ui" : root.prefix),
        targetRoot: path.resolve(config[root.configKey]),
      }])).values()];
  for (const root of stageRoots) await fsImpl.promises.mkdir(root.stageRoot, {recursive: true});
  return {files, stageDir, stageRoots};
}

async function buildWorkspacePlan({config, fsImpl, pointer, shouldIgnore, stageDir, storage}) {
  const namespace = agentSnapshotStoragePrefix(config);
  const manifest = await downloadManifest({
    config,
    expectedKind: "mapache-workspace-file-state",
    namespace,
    pointer,
    storage,
  });
  validatePointerIdentity(manifest, pointer, config, "workspace");
  if (pointer.fileCount !== undefined && Number(pointer.fileCount) !== manifest.files.length) {
    throw restoreError("checkpoint_manifest_invalid", "Workspace checkpoint file count does not match its pointer");
  }
  if (pointer.tombstoneCount !== undefined && Number(pointer.tombstoneCount) !== (manifest.tombstones || []).length) {
    throw restoreError("checkpoint_manifest_invalid", "Workspace checkpoint tombstone count does not match its pointer");
  }
  const files = [];
  const seen = new Set();
  const tombstones = new Set();
  for (const tombstone of manifest.tombstones || []) {
    const relativePath = validateRelativePath(tombstone, "workspace tombstone");
    if (tombstones.has(relativePath)) throw restoreError("checkpoint_manifest_invalid", "Workspace checkpoint contains duplicate tombstones");
    tombstones.add(relativePath);
  }
  for (const entry of manifest.files || []) {
    const relativePath = validateRelativePath(entry.path, "workspace file");
    if (seen.has(relativePath) || tombstones.has(relativePath)) {
      throw restoreError("checkpoint_manifest_invalid", `Workspace checkpoint has conflicting path: ${relativePath}`);
    }
    if (shouldIgnore(relativePath)) throw restoreError("checkpoint_manifest_invalid", `Workspace checkpoint contains an ignored path: ${relativePath}`);
    seen.add(relativePath);
    const stagedPath = path.resolve(stageDir, relativePath);
    const targetPath = path.resolve(config.workspaceDir, ...relativePath.split("/"));
    assertInside(stageDir, stagedPath, "workspace restore staging target");
    assertInside(config.workspaceDir, targetPath, "workspace restore target");
    if (entry.kind === "symlink") {
      validateSymlinkTarget(entry.target, stageDir, stagedPath);
      await fsImpl.promises.mkdir(path.dirname(stagedPath), {recursive: true});
      await fsImpl.promises.symlink(entry.target, stagedPath);
      files.push({entry, relativePath, stagedPath, targetPath, symlink: true});
      continue;
    }
    if (entry.kind !== "workspace-file") throw restoreError("checkpoint_manifest_invalid", `Unsupported workspace file kind: ${relativePath}`);
    const objectPath = expectedObjectPath(pointer, manifest, relativePath, entry.kind);
    const content = await downloadObject({
      bucketName: pointer.manifest.bucketName,
      expected: entry,
      label: relativePath,
      objectPath,
      storage,
    });
    await writeStagedFile({content, fsImpl, mode: entry.mode, stagedPath});
    files.push({entry, relativePath, stagedPath, targetPath, symlink: false});
  }
  await validateStagedSymlinkTargets({files, fsImpl, stageDir});
  return {files, stageDir, shouldIgnore, tombstones: [...tombstones]};
}

async function downloadManifest({config, expectedKind, namespace, pointer, storage}) {
  if (!pointer?.manifest) throw restoreError("checkpoint_pointer_invalid", "Published checkpoint has no manifest reference");
  const captureId = validateRemoteSegment(pointer.captureId, "checkpoint capture");
  const generation = positiveGeneration(pointer.generation);
  const bootInstanceId = validateRemoteSegment(pointer.bootInstanceId, "checkpoint boot");
  if (!generation || !bootInstanceId) throw restoreError("checkpoint_pointer_invalid", "Published checkpoint identity is incomplete");
  const expectedBase = expectedKind === "mapache-workspace-file-state" ?
    `${namespace}/${WORKSPACE_FILE_NAMESPACE}/${generation}/${bootInstanceId}/${captureId}` :
    `${namespace}/${generation}/${bootInstanceId}/${captureId}`;
  const manifestRef = pointer.manifest;
  if (manifestRef.objectPath !== `${expectedBase}/manifest.json`) {
    throw restoreError("checkpoint_pointer_invalid", "Published checkpoint manifest path is outside its identity namespace");
  }
  const content = await downloadAndVerify({
    bucketName: manifestRef.bucketName,
    byteLength: manifestRef.byteLength,
    label: "checkpoint manifest",
    objectPath: manifestRef.objectPath,
    sha256: manifestRef.sha256,
    storage,
  });
  let manifest;
  try {
    manifest = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw restoreError("checkpoint_manifest_invalid", "Published checkpoint manifest is not JSON", error);
  }
  if (manifest.manifestVersion !== CHECKPOINT_VERSION || manifest.kind !== expectedKind || manifest.storagePrefix !== namespace) {
    throw restoreError("checkpoint_manifest_invalid", "Published checkpoint manifest does not match its pointer");
  }
  if (!Array.isArray(manifest.files) || (expectedKind === "mapache-workspace-file-state" && !Array.isArray(manifest.tombstones))) {
    throw restoreError("checkpoint_manifest_invalid", "Published checkpoint manifest has an invalid file list");
  }
  return manifest;
}

async function downloadObject({bucketName, expected, label, objectPath, storage}) {
  if (!expected || Number(expected.byteLength) < 0 || !/^[a-f0-9]{64}$/.test(String(expected.sha256 || ""))) {
    throw restoreError("checkpoint_manifest_invalid", `Checkpoint checksum metadata is invalid: ${label}`);
  }
  return downloadAndVerify({
    bucketName,
    byteLength: expected.byteLength,
    label,
    objectPath,
    sha256: expected.sha256,
    storage,
  });
}

async function downloadAndVerify({bucketName, byteLength, label, objectPath, sha256: expectedSha256, storage}) {
  if (!storage || !bucketName || !objectPath) throw restoreError("checkpoint_storage_unavailable", "Checkpoint storage is not configured");
  let downloaded;
  try {
    downloaded = await storage.bucket(bucketName).file(objectPath).download();
  } catch (error) {
    throw restoreError("checkpoint_object_missing", `Checkpoint object could not be read: ${label}`, error);
  }
  const content = Buffer.isBuffer(downloaded) ? downloaded : Buffer.isBuffer(downloaded?.[0]) ? downloaded[0] : Buffer.from(downloaded?.[0] || downloaded || "");
  if (content.length !== Number(byteLength) || sha256(content) !== String(expectedSha256)) {
    throw restoreError("checkpoint_checksum_mismatch", `Checkpoint checksum mismatch: ${label}`);
  }
  return content;
}

async function installWorkspacePlan({cleanup, config, fsImpl, plan, undo}) {
  await fsImpl.promises.mkdir(config.workspaceDir, {recursive: true});
  const current = await collectWorkspaceEntries({fsImpl, root: config.workspaceDir, shouldIgnore: plan.shouldIgnore});
  const backupDir = await makeStageDir(fsImpl, path.dirname(config.workspaceDir), () => crypto.randomUUID());
  cleanup.push(backupDir);

  // Resolve directory/file type changes before moving individual managed files.
  for (const file of plan.files.slice().sort((a, b) => a.relativePath.length - b.relativePath.length)) {
    const stat = await fsImpl.promises.lstat(file.targetPath).catch(() => null);
    if (stat?.isDirectory()) await moveWorkspaceBackup({backupDir, fsImpl, relativePath: file.relativePath, targetPath: file.targetPath, undo});
  }
  for (const entry of current.sort((a, b) => b.relativePath.length - a.relativePath.length)) {
    await moveWorkspaceBackup({backupDir, fsImpl, relativePath: entry.relativePath, targetPath: entry.targetPath, undo});
  }
  for (const file of plan.files) {
    await fsImpl.promises.mkdir(path.dirname(file.targetPath), {recursive: true});
    await fsImpl.promises.rename(file.stagedPath, file.targetPath);
    undo.push(async () => fsImpl.promises.rm(file.targetPath, {recursive: true, force: true}));
  }
}

async function installAgentPlan({cleanup, config, fsImpl, plan, undo}) {
  const roots = [...new Set(AGENT_FILE_ROOTS.map(({configKey}) => config[configKey]).filter(Boolean).map((targetRoot) => path.resolve(targetRoot)))];
  for (const targetRoot of roots) {
    await fsImpl.promises.mkdir(path.dirname(targetRoot), {recursive: true});
    const backupPath = `${targetRoot}.mapache-restore-backup-${crypto.randomUUID()}`;
    const existed = await pathExists(fsImpl, targetRoot);
    if (existed) {
      await fsImpl.promises.rename(targetRoot, backupPath);
      cleanup.push(backupPath);
      undo.push(async () => {
        await fsImpl.promises.rm(targetRoot, {recursive: true, force: true});
        await fsImpl.promises.rename(backupPath, targetRoot);
      });
    }
    const stagedRoot = plan.stageRoots.find(({targetRoot: candidate}) => candidate === targetRoot)?.stageRoot;
    if (!stagedRoot) {
      await fsImpl.promises.mkdir(targetRoot, {recursive: true});
      continue;
    }
    await fsImpl.promises.rename(stagedRoot, targetRoot);
    undo.push(async () => fsImpl.promises.rm(targetRoot, {recursive: true, force: true}));
  }
}

async function moveWorkspaceBackup({backupDir, fsImpl, relativePath, targetPath, undo}) {
  if (!await pathExists(fsImpl, targetPath)) return;
  const backupPath = path.join(backupDir, ...relativePath.split("/"));
  await fsImpl.promises.mkdir(path.dirname(backupPath), {recursive: true});
  await fsImpl.promises.rename(targetPath, backupPath);
  undo.push(async () => {
    await fsImpl.promises.rm(targetPath, {recursive: true, force: true});
    await fsImpl.promises.mkdir(path.dirname(targetPath), {recursive: true});
    await fsImpl.promises.rename(backupPath, targetPath);
  });
}

async function collectWorkspaceEntries({fsImpl, root, currentDir = root, relativePrefix = "", shouldIgnore}) {
  const entries = [];
  const children = await fsImpl.promises.readdir(currentDir, {withFileTypes: true}).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const child of children) {
    const relativePath = relativePrefix ? `${relativePrefix}/${child.name}` : child.name;
    if (shouldIgnore(relativePath)) continue;
    const targetPath = path.join(currentDir, child.name);
    const stat = await fsImpl.promises.lstat(targetPath);
    if (stat.isDirectory()) {
      entries.push(...await collectWorkspaceEntries({fsImpl, root, currentDir: targetPath, relativePrefix: relativePath, shouldIgnore}));
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      entries.push({relativePath, targetPath});
    }
  }
  return entries;
}

async function readPublishedPointers({config, db}) {
  if (!db || typeof db.collection !== "function" || !config.workspaceId) {
    throw restoreError("checkpoint_coordination_unavailable", "Checkpoint coordination is not configured");
  }
  const workspaceRef = db.collection("workspaces").doc(config.workspaceId);
  if (typeof workspaceRef.get !== "function") throw restoreError("checkpoint_coordination_unavailable", "Checkpoint workspace reads are not configured");
  const authorityRef = isAutomationRuntime(config) ? workspaceRef.collection("sessions").doc(config.sessionId) : workspaceRef;
  let snapshot;
  try {
    snapshot = await authorityRef.get();
  } catch (error) {
    throw restoreError("checkpoint_coordination_unavailable", "Checkpoint authority could not be read", error);
  }
  if (!snapshot?.exists) throw restoreError("checkpoint_coordination_missing", "Checkpoint workspace document is missing");
  const data = snapshot.data() || {};
  return {agent: data.agentRuntimeCheckpoint || null, workspace: data.agentRuntimeWorkspaceFiles || null};
}

function validatePointerIdentity(manifest, pointer, config, kind) {
  if (manifest.workspaceId !== config.workspaceId || manifest.sessionId !== config.sessionId ||
      positiveGeneration(manifest.generation) !== positiveGeneration(pointer.generation) ||
      String(manifest.bootInstanceId || "") !== String(pointer.bootInstanceId || "")) {
    throw restoreError("checkpoint_generation_mismatch", `Published ${kind} checkpoint identity does not match its pointer`);
  }
}

function expectedObjectPath(pointer, manifest, relativePath, kind) {
  if (kind === "symlink" || kind === "directory") return null;
  const namespace = kind === "workspace-file" ? WORKSPACE_FILE_NAMESPACE : "";
  const base = [manifest.storagePrefix, namespace, pointer.generation, pointer.bootInstanceId, pointer.captureId]
      .filter((part) => part !== "")
      .join("/");
  const expected = `${base}/objects/${relativePath}`;
  return expected;
}

function agentRootForPath(config, relativePath, kind, stageDir) {
  const root = AGENT_FILE_ROOTS.find(({prefix}) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
  if (!root || relativePath === root.prefix) throw restoreError("checkpoint_manifest_invalid", `Unknown agent state path: ${relativePath}`);
  if (kind !== root.kind && kind !== "symlink") throw restoreError("checkpoint_manifest_invalid", `Agent state kind does not match path: ${relativePath}`);
  const relative = relativePath.slice(root.prefix.length + 1);
  const targetRoot = path.resolve(config[root.configKey], root.subdirectory || "");
  const stageRoot = path.resolve(stageDir, root.prefix === "ui" ? "ui" : root.prefix);
  const stagePrefix = root.subdirectory ? path.join("ui", root.subdirectory) : root.prefix;
  const targetRelativePath = root.subdirectory ? path.join(root.subdirectory, relative) : relative;
  return {
    relativePath: targetRelativePath,
    stageRelativePath: path.join(stagePrefix, relative),
    stageRoot: root.subdirectory ? path.join(stageRoot, root.subdirectory) : stageRoot,
    targetRoot,
  };
}

function validateAgentContent(entry, content, relativePath) {
  if (entry.kind === "pi-transcript") {
    const parsed = parseCompleteJsonl(content, relativePath);
    if (parsed.truncated) throw restoreError("checkpoint_manifest_invalid", `Restored transcript is incomplete: ${relativePath}`);
    if (entry.recordCount !== undefined && Number(entry.recordCount) !== parsed.records.length) {
      throw restoreError("checkpoint_manifest_invalid", `Restored transcript record count is invalid: ${relativePath}`);
    }
    return;
  }
  if ((entry.kind === "pi-setting" || entry.kind === "ui-state") && path.posix.extname(relativePath).toLowerCase() === ".json") {
    try {
      const parsed = JSON.parse(content.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || (entry.kind === "pi-setting" && Array.isArray(parsed))) {
        throw new Error("invalid JSON state shape");
      }
    } catch (error) {
      throw restoreError("checkpoint_manifest_invalid", `Restored JSON state is invalid: ${relativePath}`, error);
    }
  }
}

async function writeStagedFile({content, fsImpl, mode, stagedPath}) {
  const safeMode = safeModeBits(mode);
  await fsImpl.promises.mkdir(path.dirname(stagedPath), {recursive: true});
  await fsImpl.promises.writeFile(stagedPath, content, {mode: safeMode});
  await fsImpl.promises.chmod(stagedPath, safeMode).catch(() => {});
}

function validateSymlinkTarget(target, stageRoot, stagedPath) {
  const relativeTarget = String(target || "");
  if (!relativeTarget || path.isAbsolute(relativeTarget)) throw restoreError("checkpoint_unsafe_symlink", "Checkpoint symlink target is absolute or empty");
  const resolved = path.resolve(path.dirname(stagedPath), relativeTarget);
  try {
    assertInside(stageRoot, resolved, "checkpoint symlink target");
  } catch (error) {
    throw restoreError("checkpoint_unsafe_symlink", "Checkpoint symlink target escapes its root", error);
  }
}

async function validateStagedSymlinkTargets({files, fsImpl}) {
  for (const file of files.filter(({symlink}) => symlink)) {
    const targetPath = path.resolve(path.dirname(file.stagedPath), file.entry.target);
    try {
      await fsImpl.promises.lstat(targetPath);
    } catch (error) {
      throw restoreError("checkpoint_unsafe_symlink", `Checkpoint symlink target is missing: ${file.relativePath}`, error);
    }
  }
}

async function makeStageDir(fsImpl, parent, randomId) {
  if (!parent) throw restoreError("checkpoint_restore_unavailable", "Checkpoint restore parent is not configured");
  await fsImpl.promises.mkdir(parent, {recursive: true});
  return fsImpl.promises.mkdtemp(path.join(parent, `.mapache-checkpoint-${String(randomId()).replace(/[^A-Za-z0-9-]/g, "-")}-`));
}

async function pathExists(fsImpl, target) {
  try {
    await fsImpl.promises.lstat(target);
    return true;
  } catch (error) {
    return false;
  }
}

async function rollback(undo) {
  for (const action of undo.reverse()) await action().catch(() => {});
}

async function cleanupPaths(paths, fsImpl = fs) {
  for (const target of paths) await fsImpl.promises.rm(target, {recursive: true, force: true}).catch(() => {});
}

function safeModeBits(value) {
  const mode = Number(value);
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o777 ? mode : 0o600;
}

function assertInside(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw restoreError("checkpoint_path_traversal", `${label} escapes its root`);
  }
}

function positiveGeneration(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function validateRemoteSegment(value, label) {
  const segment = String(value || "");
  if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
    throw restoreError("checkpoint_pointer_invalid", `${label} identity is unsafe`);
  }
  return segment;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function restoreError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

module.exports = {
  createAgentCheckpointRestoreService,
  restorePublishedCheckpoint,
};
