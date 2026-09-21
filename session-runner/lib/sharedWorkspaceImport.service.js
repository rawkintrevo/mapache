"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {runCommand: defaultRunCommand} = require("./processes");
const {validateRelativePath} = require("./agentCheckpoint.service");
const {
  DIRECTORY_MARKER_FILE,
  INTERNAL_STORAGE_DIR,
  isInternalStorageDirName,
  SHARED_WORKSPACE_READY_MARKER,
} = require("./runtimePaths");

const IMPORT_VERSION = 1;
const IMPORT_KIND = "mapache-shared-workspace-import";
const CONTROL_DIR = `${INTERNAL_STORAGE_DIR}/shared-workspace-imports`;
const GIT_SEED_DIR = "shared-workspace/git";

function createSharedWorkspaceImportService({
  config = {},
  fsImpl = fs,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID(),
  runCommand = defaultRunCommand,
  storage,
} = {}) {
  function importWorktree(options = {}) {
    return importGeneration({...options, config, fsImpl, now, randomId, runCommand, storage});
  }

  function cleanupUnpublished(options = {}) {
    return cleanupImport({...options, config, fsImpl, storage});
  }

  return {
    cleanupUnpublished,
    importGeneration: importWorktree,
    importPublishedCheckpoint: importWorktree,
    importWorktree,
  };
}

async function importGeneration({
  bucketName,
  config = {},
  fsImpl = fs,
  now = () => Date.now(),
  operationId = "",
  randomId = () => crypto.randomUUID(),
  runCommand = defaultRunCommand,
  sourceRoot,
  storage,
} = {}) {
  const bucket = String(bucketName || config.bucketName || "").trim();
  if (!bucket || !storage) throw importError("shared_workspace_import_storage_unavailable", "Shared workspace import storage is not configured");
  const source = path.resolve(String(sourceRoot || ""));
  if (!sourceRoot) throw importError("shared_workspace_import_source_missing", "A verified local workspace staging root is required");
  const operation = cleanSegment(operationId || randomId());
  const treePrefix = `trees/${operation}`;
  const controlPrefix = `${CONTROL_DIR}/${operation}`;
  const controlPath = `${controlPrefix}/control.json`;
  const generation = operation;
  const timestamp = () => new Date(now()).toISOString();

  const stat = await fsImpl.promises.stat(source).catch((error) => {
    throw importError("shared_workspace_import_source_missing", "Workspace staging root is unavailable", error);
  });
  if (!stat.isDirectory()) throw importError("shared_workspace_import_source_invalid", "Workspace staging root is not a directory");

  const localStage = await fsImpl.promises.mkdtemp(path.join(os.tmpdir(), "mapache-shared-import-"));
  try {
    const entries = await collectWorktreeEntries({fsImpl, root: source});
    const gitSeed = await collectGitSeed({fsImpl, root: source, runCommand, stageRoot: localStage});
    let control = await readControlManifest({bucket, controlPath, storage});
    if (control && (control.operationId !== operation || control.treePrefix !== treePrefix)) {
      throw importError("shared_workspace_import_control_conflict", "Existing import control manifest does not match the operation");
    }
    control = control || {
      version: IMPORT_VERSION,
      kind: IMPORT_KIND,
      operationId: operation,
      storageGeneration: generation,
      treePrefix,
      state: "uploading",
      source: {
        workspaceId: config.workspaceId || null,
        sourceRoot: source,
      },
      objects: [],
      gitSeed: null,
      updatedAt: timestamp(),
    };
    if (control.state === "ready") {
      await verifyDestination({bucket, control, storage});
      return completedResult({bucket, control, readyMarker: SHARED_WORKSPACE_READY_MARKER, storageGeneration: generation});
    }

    const recorded = new Map((Array.isArray(control.objects) ? control.objects : []).map((object) => [object.path, object]));
    for (const entry of entries) {
      const remotePath = entry.kind === "directory" ?
        `${treePrefix}/${entry.path}/${DIRECTORY_MARKER_FILE}` : `${treePrefix}/${entry.path}`;
      const object = await ensureObject({
        bucket,
        content: entry.content,
        kind: entry.kind,
        mode: entry.mode,
        operation,
        path: remotePath,
        sha256: entry.sha256,
        storage,
        symlinkTarget: entry.target,
      });
      recorded.set(remotePath, {
        ...object,
        relativePath: entry.path,
        kind: entry.kind,
        mode: entry.mode,
      });
      control.objects = [...recorded.values()].sort((left, right) => left.path.localeCompare(right.path));
      control.updatedAt = timestamp();
      await writeControlManifest({bucket, controlPath, control, storage});
    }

    if (gitSeed) {
      const seedPath = gitSeedPath(config, operation);
      const seedObject = await ensureObject({
        bucket,
        content: await fsImpl.promises.readFile(gitSeed.archivePath),
        kind: "private-git-seed",
        mode: 0o600,
        operation,
        path: seedPath,
        sha256: gitSeed.sha256,
        storage,
      });
      control.gitSeed = {...seedObject, path: seedPath};
      control.updatedAt = timestamp();
      await writeControlManifest({bucket, controlPath, control, storage});
    }

    await verifyDestination({bucket, control, storage});
    const markerPath = readyMarkerPath(treePrefix);
    const markerContent = Buffer.from(`${JSON.stringify({
      kind: "mapache-shared-workspace-ready",
      state: "ready",
      storageGeneration: generation,
      operationId: operation,
    })}\n`, "utf8");
    const markerObject = await ensureObject({
      bucket,
      content: markerContent,
      kind: "ready-marker",
      mode: 0o644,
      operation,
      path: markerPath,
      sha256: sha256(markerContent),
      storage,
    });
    control.objects = [...(control.objects || []), markerObject]
        .filter((object, index, list) => list.findIndex((candidate) => candidate.path === object.path) === index)
        .sort((left, right) => left.path.localeCompare(right.path));
    control.state = "ready";
    control.readyMarkerObjectPath = markerPath;
    control.updatedAt = timestamp();
    await writeControlManifest({bucket, controlPath, control, storage});
    return completedResult({bucket, control, readyMarker: SHARED_WORKSPACE_READY_MARKER, storageGeneration: generation});
  } catch (error) {
    if (error?.code?.startsWith("shared_workspace_import_")) throw error;
    throw importError("shared_workspace_import_failed", error.message || "Shared workspace import failed", error);
  } finally {
    await fsImpl.promises.rm(localStage, {recursive: true, force: true}).catch(() => {});
  }
}

async function collectWorktreeEntries({fsImpl, root}) {
  const entries = [];
  await walkDirectory({entries, fsImpl, root, current: root});
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function walkDirectory({entries, fsImpl, root, current}) {
  const directoryEntries = await fsImpl.promises.readdir(current, {withFileTypes: true});
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
  for (const directoryEntry of directoryEntries) {
    const localPath = path.join(current, directoryEntry.name);
    const relative = path.relative(root, localPath).split(path.sep).join("/");
    validateRelativePath(relative, "workspace import path");
    if (isReservedInternalPath(relative)) continue;
    if (directoryEntry.name === ".git") {
      if (current !== root) throw importError("shared_workspace_import_nested_git", `Nested Git metadata is not supported: ${relative}`);
      continue;
    }
    const stat = await fsImpl.promises.lstat(localPath);
    const mode = stat.mode & 0o7777;
    if (stat.isDirectory()) {
      entries.push({kind: "directory", mode, path: relative, sha256: sha256(Buffer.alloc(0))});
      await walkDirectory({entries, fsImpl, root, current: localPath});
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = await fsImpl.promises.readlink(localPath);
      await validateSymlink({fsImpl, linkPath: localPath, root, target, relative});
      const content = Buffer.from(target, "utf8");
      entries.push({kind: "symlink", mode, path: relative, sha256: sha256(content), content, target});
      continue;
    }
    if (!stat.isFile()) throw importError("shared_workspace_import_unsupported_file", `Unsupported filesystem entry: ${relative}`);
    const content = await fsImpl.promises.readFile(localPath);
    const after = await fsImpl.promises.lstat(localPath);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw importError("shared_workspace_import_source_changed", `Source changed while importing: ${relative}`);
    }
    entries.push({kind: "file", mode, path: relative, sha256: sha256(content), content});
  }
}

async function validateSymlink({fsImpl, linkPath, relative, root, target}) {
  if (!target || path.isAbsolute(target)) throw importError("shared_workspace_import_unsafe_symlink", `Symlink is absolute or empty: ${relative}`);
  const targetPath = path.resolve(path.dirname(linkPath), target);
  if (!isInside(root, targetPath)) throw importError("shared_workspace_import_unsafe_symlink", `Symlink escapes staging root: ${relative}`);
  try {
    await fsImpl.promises.realpath(targetPath);
  } catch (error) {
    throw importError("shared_workspace_import_unsafe_symlink", `Symlink target is missing: ${relative}`, error);
  }
}

async function collectGitSeed({fsImpl, root, runCommand, stageRoot}) {
  const gitPath = path.join(root, ".git");
  const gitStat = await fsImpl.promises.lstat(gitPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!gitStat) return null;
  const index = await runCommand("git", ["ls-files", "-s"], {cwd: root, captureStdout: true}).catch((error) => {
    throw importError("shared_workspace_import_git_invalid", "Git metadata could not be validated", error);
  });
  const submodule = String(index || "").split(/\r?\n/).find((line) => /^160000\s/.test(line));
  if (submodule) throw importError("shared_workspace_import_submodule_unsupported", `Git submodule is not supported: ${submodule.slice(0, 256)}`);
  const resolvedGitPath = gitStat.isSymbolicLink() ? await fsImpl.promises.realpath(gitPath) : gitPath;
  const archivePath = path.join(stageRoot, "git-seed.tar.gz");
  await runCommand("tar", ["-czf", archivePath, "-C", resolvedGitPath, "."], {cwd: "/"});
  const content = await fsImpl.promises.readFile(archivePath);
  return {archivePath, sha256: sha256(content)};
}

async function ensureObject({bucket, content, kind, mode, operation, path: objectPath, sha256: expectedSha256, storage, symlinkTarget}) {
  const file = storage.bucket(bucket).file(objectPath);
  let metadata = null;
  try {
    [metadata] = await file.getMetadata();
  } catch (error) {
    if (!(error?.code === 404 || error?.code === "ENOENT")) throw error;
  }
  if (metadata) {
    const custom = metadata.metadata || {};
    const existingHash = String(custom.mapacheImportSha256 || "");
    if (existingHash && existingHash !== expectedSha256) {
      throw importError("shared_workspace_import_destination_conflict", `Destination object changed: ${objectPath}`);
    }
    if (custom.mapacheImportOperationId && custom.mapacheImportOperationId !== operation) {
      throw importError("shared_workspace_import_destination_conflict", `Destination object belongs to another import: ${objectPath}`);
    }
    const [existingContent] = await file.download();
    if (sha256(existingContent) !== expectedSha256) {
      throw importError("shared_workspace_import_destination_conflict", `Destination object hash does not match: ${objectPath}`);
    }
    return objectReference({metadata, objectPath, sha256: expectedSha256});
  }
  const options = {
    ifGenerationMatch: 0,
    resumable: false,
    contentType: kind === "file" ? "application/octet-stream" : "application/json",
    metadata: {
      metadata: {
        mapacheImportKind: kind,
        mapacheImportOperationId: operation,
        mapacheImportSha256: expectedSha256,
        mapacheMode: String(mode),
        ...(symlinkTarget ? {mapacheSymlinkTarget: symlinkTarget} : {}),
      },
    },
  };
  const body = kind === "directory" ? Buffer.alloc(0) : content;
  await file.save(body, options);
  const [savedMetadata] = await file.getMetadata().catch(() => [null]);
  return objectReference({metadata: savedMetadata, objectPath, sha256: expectedSha256});
}

async function verifyDestination({bucket, control, storage}) {
  for (const object of control.objects || []) {
    const file = storage.bucket(bucket).file(object.path);
    const [metadata] = await file.getMetadata().catch((error) => {
      throw importError("shared_workspace_import_destination_missing", `Destination object disappeared: ${object.path}`, error);
    });
    const currentHash = String(metadata.metadata?.mapacheImportSha256 || "");
    if (currentHash !== object.sha256) throw importError("shared_workspace_import_destination_conflict", `Destination object verification failed: ${object.path}`);
    const [content] = await file.download();
    if (sha256(content) !== object.sha256) throw importError("shared_workspace_import_destination_conflict", `Destination object hash changed: ${object.path}`);
  }
  if (control.gitSeed) {
    const file = storage.bucket(bucket).file(control.gitSeed.path);
    const [metadata] = await file.getMetadata();
    if (String(metadata.metadata?.mapacheImportSha256 || "") !== control.gitSeed.sha256) {
      throw importError("shared_workspace_import_destination_conflict", "Private Git seed verification failed");
    }
    const [content] = await file.download();
    if (sha256(content) !== control.gitSeed.sha256) {
      throw importError("shared_workspace_import_destination_conflict", "Private Git seed hash does not match");
    }
  }
}

async function readControlManifest({bucket, controlPath, storage}) {
  const file = storage.bucket(bucket).file(controlPath);
  try {
    const [content] = await file.download();
    let control;
    try {
      control = JSON.parse(content.toString("utf8"));
    } catch (error) {
      throw importError("shared_workspace_import_control_invalid", "Import control manifest is not valid JSON", error);
    }
    if (control.version !== IMPORT_VERSION || control.kind !== IMPORT_KIND) {
      throw importError("shared_workspace_import_control_invalid", "Import control manifest is invalid");
    }
    return control;
  } catch (error) {
    if (error?.code === 404 || error?.code === "ENOENT") return null;
    if (error?.code?.startsWith("shared_workspace_import_")) throw error;
    return null;
  }
}

async function writeControlManifest({bucket, controlPath, control, storage}) {
  await storage.bucket(bucket).file(controlPath).save(Buffer.from(`${JSON.stringify(control, null, 2)}\n`, "utf8"), {
    contentType: "application/json",
    resumable: false,
  });
}

async function cleanupImport({bucketName, config = {}, fsImpl = fs, operationId, storage}) {
  const bucket = String(bucketName || config.bucketName || "").trim();
  if (!storage || !bucket || !operationId) return {ok: true, skipped: true};
  const operation = cleanSegment(operationId);
  const controlPath = `${CONTROL_DIR}/${operation}/control.json`;
  const control = await readControlManifest({bucket, controlPath, storage});
  if (!control) return {ok: true, skipped: true, reason: "no_control_manifest"};
  if (control.state === "ready") throw importError("shared_workspace_import_active_generation", "Ready shared workspace generations cannot be cleaned up");
  const deleted = [];
  const objects = new Map(
      [...(control.objects || []), control.gitSeed, {
        path: readyMarkerPath(control.treePrefix || `trees/${operation}`),
      }]
          .filter(Boolean)
          .map((object) => [object.path, object]),
  );
  for (const object of objects.values()) {
    const file = storage.bucket(bucket).file(object.path);
    const [metadata] = await file.getMetadata().catch(() => [null]);
    if (metadata?.metadata?.mapacheImportOperationId !== operation) continue;
    await file.delete({ignoreNotFound: true, ifGenerationMatch: metadata.generation});
    deleted.push(object.path);
  }
  const controlFile = storage.bucket(bucket).file(controlPath);
  await controlFile.delete({ignoreNotFound: true});
  return {ok: true, deleted};
}

function completedResult({bucket, control, readyMarker, storageGeneration}) {
  return {
    ok: true,
    bucketName: bucket,
    controlManifestPath: `${CONTROL_DIR}/${control.operationId}/control.json`,
    readyMarker,
    readyMarkerObjectPath: control.readyMarkerObjectPath || readyMarkerPath(control.treePrefix),
    storageGeneration,
    treePrefix: control.treePrefix,
    gitSeed: control.gitSeed,
    objectCount: control.objects.length,
    state: control.state,
  };
}

function gitSeedPath(config, operationId) {
  const prefix = String(config.prefix || "").replace(/^\/+|\/+$/g, "");
  return `${prefix ? `${prefix}/` : ""}${INTERNAL_STORAGE_DIR}/${GIT_SEED_DIR}/seed.tar.gz`;
}

function readyMarkerPath(treePrefix) {
  return `${treePrefix}/${SHARED_WORKSPACE_READY_MARKER}`;
}

function isReservedInternalPath(relative) {
  const first = String(relative || "").split("/")[0];
  return isInternalStorageDirName(first);
}

function isInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function objectReference({metadata, objectPath, sha256: hash}) {
  return {
    generation: metadata?.generation || null,
    path: objectPath,
    sha256: hash,
  };
}

function cleanSegment(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 160) || "operation";
}

function importError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

module.exports = {
  CONTROL_DIR,
  GIT_SEED_DIR,
  IMPORT_KIND,
  IMPORT_VERSION,
  createSharedWorkspaceImportService,
  collectWorktreeEntries,
  readyMarkerPath,
  validateArchiveEntryPath: validateRelativePath,
};
