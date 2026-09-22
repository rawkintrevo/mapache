"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {agentSnapshotStoragePrefix} = require("./agentSnapshot.service");
const {generationMatchOptions} = require("./workspaceSyncGeneration.helpers");
const {isMountedWorkspaceMode} = require("./sharedWorkspace.helpers");

const CHECKPOINT_VERSION = 1;
const WORKSPACE_FILE_NAMESPACE = "workspace-files";

function isAutomationRuntime(config = {}) {
  return String(config.runtimeKind || "").trim().toLowerCase() === "automation";
}

/**
 * Owns immutable agent-state and workspace-file publication. Capture is kept
 * separate in agentSnapshot.service.js so a local snapshot can be tested and
 * inspected without granting it a remote-write capability.
 */
function createAgentCheckpointService({
  admin,
  config = {},
  db,
  fsImpl = fs,
  faultHarness,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID(),
  storage,
} = {}) {
  const enabled = config.agentRuntimeEnabled === true || config.agentUiVersion === "pi-web-ui-v1";

  return {
    enabled: () => enabled,
    uploadCapture: (capture, options = {}) => {
      if (!enabled && options.allowUnmarked !== true) return Promise.resolve({enabled: false, skipped: true});
      return uploadCapture({
        ...options,
        admin,
        capture,
        config,
        db,
        fsImpl,
        now,
        randomId,
        storage,
      });
    },
    commitCheckpoint: (uploaded, options = {}) => {
      if (!enabled && options.allowUnmarked !== true) return Promise.resolve({enabled: false, skipped: true});
      return commitCheckpoint({
        ...options,
        admin,
        config,
        db,
        faultHarness,
        uploaded,
        now,
      });
    },
    publishWorkspaceFiles: (options = {}) => {
      if (isMountedWorkspaceMode(config.workspaceStorageMode)) {
        return Promise.resolve({enabled: true, skipped: true, reason: "shared_gcsfuse_authoritative"});
      }
      if (!enabled && options.allowUnmarked !== true) return Promise.resolve({enabled: false, skipped: true});
      return publishWorkspaceFiles({
        ...options,
        admin,
        config,
        db,
        faultHarness,
        fsImpl,
        now,
        randomId,
        storage,
      });
    },
    status: (options = {}) => getCheckpointStatus({
      config,
      db,
      ...options,
    }),
    recordCheckpointError: (code, options = {}) => {
      if (!enabled && options.allowUnmarked !== true) return Promise.resolve({enabled: false, skipped: true});
      return recordCheckpointError({
        ...options,
        admin,
        config,
        db,
        errorCode: code,
        now,
      });
    },
  };
}

/**
 * Upload a Task 14 capture as immutable objects. This function deliberately
 * does not accept db or a pointer and therefore cannot publish a checkpoint.
 * An interrupted upload can leave diagnosable orphan objects, but no reader
 * can discover them until commitCheckpoint succeeds.
 */
async function uploadCapture({
  admin,
  capture,
  config = {},
  fsImpl = fs,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID(),
  storage,
  uploadObject,
} = {}) {
  const {manifest, stagingDir} = normalizeCapture(capture);
  const identity = validateManifest(manifest, config);
  if (!storage && typeof uploadObject !== "function") {
    throw checkpointError("checkpoint_storage_unavailable", "Checkpoint storage is not configured");
  }
  const bucketName = String(capture?.bucketName || config.bucketName || "").trim();
  if (!bucketName) throw checkpointError("checkpoint_storage_unavailable", "Checkpoint bucket is not configured");
  const captureId = cleanRemoteSegment(capture?.captureId || randomId());
  const basePath = [
    manifest.storagePrefix,
    String(identity.generation),
    cleanRemoteSegment(identity.bootInstanceId),
    captureId,
  ].join("/");
  const objectRefs = [];
  const uploadedFiles = [];

  for (const file of manifest.files || []) {
    const relativePath = validateRelativePath(file.path, "manifest file");
    if (file.kind === "symlink" || file.kind === "directory") {
      uploadedFiles.push({...file, path: relativePath, objectPath: null});
      continue;
    }
    const localPath = resolveStagingPath(stagingDir, relativePath);
    const stat = await fsImpl.promises.lstat(localPath).catch((error) => {
      throw checkpointError("checkpoint_capture_invalid", `Captured file is missing: ${relativePath}`, error);
    });
    if (!stat.isFile()) throw checkpointError("checkpoint_capture_invalid", `Captured path is not a file: ${relativePath}`);
    const content = await fsImpl.promises.readFile(localPath);
    verifyContent(file, content, relativePath);
    const objectPath = `${basePath}/objects/${relativePath}`;
    await writeImmutableObject({
      admin,
      bucketName,
      contentType: "application/octet-stream",
      fsImpl,
      localPath,
      metadata: {mapacheCapturePath: relativePath},
      objectPath,
      storage,
      uploadObject,
    });
    const ref = objectReference({bucketName, content, objectPath});
    objectRefs.push(ref);
    uploadedFiles.push({...file, path: relativePath, objectPath});
  }

  const remoteManifest = {
    ...manifest,
    files: uploadedFiles,
    publishedObjectLayout: "objects/{relative-path}",
  };
  const manifestContent = Buffer.from(`${JSON.stringify(remoteManifest, null, 2)}\n`, "utf8");
  const manifestObjectPath = `${basePath}/manifest.json`;
  await writeImmutableObject({
    admin,
    bucketName,
    content: manifestContent,
    contentType: "application/json",
    metadata: {mapacheCaptureManifest: "1"},
    objectPath: manifestObjectPath,
    storage,
    uploadObject,
  });
  const manifestRef = objectReference({bucketName, content: manifestContent, objectPath: manifestObjectPath});
  return {
    enabled: true,
    captureId,
    bucketName,
    basePath,
    manifest: remoteManifest,
    manifestRef,
    objects: [...objectRefs, manifestRef],
    uploadedAt: toIsoTimestamp(now()),
  };
}

/**
 * Publish the full agent capture pointer only after re-reading the authority
 * documents in the same Firestore transaction that writes the pointer.
 */
async function commitCheckpoint({
  admin,
  config = {},
  db,
  faultHarness,
  now = () => Date.now(),
  uploaded,
} = {}) {
  if (!db || typeof db.runTransaction !== "function") {
    throw checkpointError("checkpoint_coordination_unavailable", "Checkpoint coordination is not configured");
  }
  if (!uploaded?.manifestRef || !uploaded.manifest) {
    throw checkpointError("checkpoint_capture_invalid", "Uploaded capture has no manifest reference");
  }
  const identity = validateManifest(uploaded.manifest, config);
  const timestamp = serverTimestamp(admin, now);
  const workspaceRef = workspaceDocument(db, identity.workspaceId);
  const sessionRef = sessionDocument(workspaceRef, identity.sessionId);
  const pointer = {
    captureId: cleanRemoteSegment(uploaded.captureId),
    generation: identity.generation,
    bootInstanceId: identity.bootInstanceId,
    capturedAt: uploaded.manifest.capturedAt,
    fileCount: (uploaded.manifest.files || []).length,
    manifest: safeObjectReference(uploaded.manifestRef),
    publishedAt: timestamp,
  };

  await injectPublicationFailure(faultHarness);
  await db.runTransaction(async (transaction) => {
    const [workspaceSnap, sessionSnap] = await Promise.all([
      transaction.get(workspaceRef),
      transaction.get(sessionRef),
    ]);
    if (!workspaceSnap.exists || !sessionSnap.exists) {
      throw checkpointError("checkpoint_writer_not_current", "Checkpoint authority documents are missing");
    }
    assertCurrentAuthority(workspaceSnap.data() || {}, sessionSnap.data() || {}, identity);
    const updates = {
      agentRuntimeCheckpoint: pointer,
      agentRuntimeCheckpointError: null,
      agentRuntimeLastCheckpointAt: timestamp,
    };
    if (!isAutomationRuntime(config)) transaction.update(workspaceRef, updates);
    transaction.update(sessionRef, updates);
  });
  return {ok: true, pointer};
}

/**
 * Immutable workspace-file publication. `files` may be supplied by a caller,
 * or the service walks config.workspaceDir. No deletion is sent to the old
 * flat workspace prefix; the committed manifest and its tombstones are the
 * authoritative file view.
 */
async function publishWorkspaceFiles({
  admin,
  basePointer,
  bootInstanceId,
  config = {},
  db,
  files,
  fsImpl = fs,
  faultHarness,
  generation,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID(),
  sessionId,
  shouldIgnore = () => false,
  sourceRoot = config.workspaceDir,
  storage,
  tombstones,
  uploadObject,
  workspaceId,
  assertCurrentWriter,
} = {}) {
  if (isMountedWorkspaceMode(config.workspaceStorageMode)) {
    return {enabled: true, skipped: true, reason: "shared_gcsfuse_authoritative"};
  }
  const identity = validateIdentity({
    bootInstanceId: bootInstanceId || config.agentRuntimeBootInstanceId,
    generation: generation || config.agentRuntimeGeneration,
    sessionId: sessionId || config.sessionId,
    workspaceId: workspaceId || config.workspaceId,
  });
  if (typeof assertCurrentWriter === "function") await assertCurrentWriter();
  const sourceFiles = files || await collectWorkspaceFiles({fsImpl, root: sourceRoot, shouldIgnore});
  let publicationBase = basePointer;
  let previousPaths = [];
  if (publicationBase === undefined) {
    const previous = await readPublishedWorkspaceState({config, db, identity, storage});
    publicationBase = previous.pointer;
    previousPaths = previous.paths;
  } else if (tombstones === undefined && publicationBase) {
    const previousManifest = await readWorkspaceManifest({config, pointer: publicationBase, storage});
    previousPaths = (previousManifest.files || [])
        .map((file) => validateRelativePath(file.path, "published workspace file"));
  }
  const currentPaths = new Set(sourceFiles.map((sourceFile) => validateRelativePath(sourceFile.path, "workspace file")));
  const requestedTombstones = tombstones === undefined ?
    previousPaths.filter((entry) => !currentPaths.has(entry)) : tombstones;
  const normalizedTombstones = [...new Set(requestedTombstones.map((entry) => validateRelativePath(entry, "tombstone")))].sort();
  const manifest = {
    manifestVersion: CHECKPOINT_VERSION,
    kind: "mapache-workspace-file-state",
    storagePrefix: agentSnapshotStoragePrefix(config),
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    generation: identity.generation,
    bootInstanceId: identity.bootInstanceId,
    capturedAt: toIsoTimestamp(now()),
    files: [],
    tombstones: normalizedTombstones,
  };
  const captureId = cleanRemoteSegment(randomId());
  const basePath = [
    manifest.storagePrefix,
    WORKSPACE_FILE_NAMESPACE,
    String(identity.generation),
    cleanRemoteSegment(identity.bootInstanceId),
    captureId,
  ].join("/");
  const objectRefs = [];

  for (const sourceFile of sourceFiles) {
    const relativePath = validateRelativePath(sourceFile.path, "workspace file");
    const kind = sourceFile.kind || "workspace-file";
    if (kind === "symlink") {
      manifest.files.push({
        path: relativePath,
        kind,
        byteLength: Buffer.byteLength(String(sourceFile.target || ""), "utf8"),
        sha256: sha256(Buffer.from(String(sourceFile.target || ""), "utf8")),
        mode: sourceFile.mode || 0o777,
        target: String(sourceFile.target || ""),
        objectPath: null,
      });
      continue;
    }
    const localPath = sourceFile.localPath || resolveStagingPath(sourceRoot, relativePath);
    const stat = sourceFile.content !== undefined ?
      {mode: sourceFile.mode || 0o600, isFile: () => true} : await fsImpl.promises.lstat(localPath);
    if (!stat.isFile()) throw checkpointError("checkpoint_workspace_file_invalid", `Workspace path is not a file: ${relativePath}`);
    const content = Buffer.isBuffer(sourceFile.content) ? sourceFile.content :
      sourceFile.content !== undefined ? Buffer.from(String(sourceFile.content), "utf8") : await fsImpl.promises.readFile(localPath);
    const file = {
      path: relativePath,
      kind,
      byteLength: content.length,
      sha256: sha256(content),
      mode: stat.mode & 0o777,
    };
    const objectPath = `${basePath}/objects/${relativePath}`;
    await writeImmutableObject({
      admin,
      bucketName: config.bucketName,
      contentType: "application/octet-stream",
      fsImpl,
      localPath,
      content: sourceFile.content !== undefined ? content : undefined,
      metadata: {mapacheWorkspacePath: relativePath},
      objectPath,
      storage,
      uploadObject,
    });
    file.objectPath = objectPath;
    objectRefs.push(objectReference({bucketName: config.bucketName, content, objectPath}));
    manifest.files.push(file);
  }
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestObjectPath = `${basePath}/manifest.json`;
  await writeImmutableObject({
      admin,
    bucketName: config.bucketName,
    content: manifestContent,
    contentType: "application/json",
    metadata: {mapacheWorkspaceManifest: "1"},
    objectPath: manifestObjectPath,
    storage,
    uploadObject,
  });
  const manifestRef = objectReference({bucketName: config.bucketName, content: manifestContent, objectPath: manifestObjectPath});
  const committed = await commitWorkspaceFileManifest({
    admin,
    basePointer: publicationBase,
    config,
    db,
    faultHarness,
    identity,
    manifestRef,
    now,
    pointer: {
      captureId,
      generation: identity.generation,
      bootInstanceId: identity.bootInstanceId,
      capturedAt: manifest.capturedAt,
      fileCount: manifest.files.length,
      tombstoneCount: manifest.tombstones.length,
      manifest: manifestRef,
    },
  });
  return {
    ...committed,
    enabled: true,
    captureId,
    bucketName: config.bucketName,
    basePath,
    manifest,
    manifestRef,
    objects: [...objectRefs, manifestRef],
  };
}

async function commitWorkspaceFileManifest({
  admin,
  basePointer,
  config,
  db,
  faultHarness,
  identity,
  now,
  pointer,
} = {}) {
  if (!db || typeof db.runTransaction !== "function") {
    throw checkpointError("checkpoint_coordination_unavailable", "Checkpoint coordination is not configured");
  }
  const timestamp = serverTimestamp(admin, now);
  const workspaceRef = workspaceDocument(db, identity.workspaceId);
  const sessionRef = sessionDocument(workspaceRef, identity.sessionId);
  const expectedCaptureId = basePointer?.captureId || null;
  await injectPublicationFailure(faultHarness);
  await db.runTransaction(async (transaction) => {
    const [workspaceSnap, sessionSnap] = await Promise.all([
      transaction.get(workspaceRef),
      transaction.get(sessionRef),
    ]);
    if (!workspaceSnap.exists || !sessionSnap.exists) {
      throw checkpointError("checkpoint_writer_not_current", "Workspace publication authority documents are missing");
    }
    const workspace = workspaceSnap.data() || {};
    const session = sessionSnap.data() || {};
    assertCurrentAuthority(workspace, session, identity);
    const currentCaptureId = (isAutomationRuntime(config) ? session : workspace).agentRuntimeWorkspaceFiles?.captureId || null;
    if (currentCaptureId !== expectedCaptureId) {
      throw checkpointError("checkpoint_publication_conflict", "Workspace file publication base is stale");
    }
    const publishedPointer = {...pointer, publishedAt: timestamp};
    if (!isAutomationRuntime(config)) transaction.update(workspaceRef, {agentRuntimeWorkspaceFiles: publishedPointer});
    transaction.update(sessionRef, {agentRuntimeWorkspaceFiles: publishedPointer});
  });
  return {ok: true, pointer: {...pointer, publishedAt: timestamp}};
}

async function readPublishedWorkspaceState({config = {}, db, identity, storage} = {}) {
  if (!db || typeof db.collection !== "function") {
    throw checkpointError("checkpoint_coordination_unavailable", "Checkpoint coordination is not configured");
  }
  const workspaceRef = workspaceDocument(db, identity.workspaceId);
  if (typeof workspaceRef.get !== "function") {
    throw checkpointError("checkpoint_coordination_unavailable", "Checkpoint workspace reads are not configured");
  }
  const authorityRef = isAutomationRuntime(config) ? sessionDocument(workspaceRef, identity.sessionId) : workspaceRef;
  const authoritySnap = await authorityRef.get();
  if (!authoritySnap?.exists) {
    throw checkpointError("checkpoint_writer_not_current", "Checkpoint workspace document is missing");
  }
  const pointer = authoritySnap.data()?.agentRuntimeWorkspaceFiles || null;
  if (!pointer) return {paths: [], pointer: null};
  const manifest = await readWorkspaceManifest({config, pointer, storage});
  return {
    paths: (manifest.files || []).map((file) => validateRelativePath(file.path, "published workspace file")),
    pointer,
  };
}

async function readWorkspaceManifest({config = {}, pointer, storage} = {}) {
  if (!storage || !pointer?.manifest?.bucketName || !pointer.manifest.objectPath) {
    throw checkpointError("checkpoint_previous_manifest_unavailable", "Published workspace manifest is unavailable");
  }
  let downloaded;
  try {
    downloaded = await storage.bucket(pointer.manifest.bucketName).file(pointer.manifest.objectPath).download();
  } catch (error) {
    throw checkpointError("checkpoint_previous_manifest_unavailable", "Published workspace manifest could not be read", error);
  }
  const content = Array.isArray(downloaded) ? downloaded[0] : downloaded;
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(content).toString("utf8"));
  } catch (error) {
    throw checkpointError("checkpoint_previous_manifest_invalid", "Published workspace manifest is invalid", error);
  }
  if (manifest.manifestVersion !== CHECKPOINT_VERSION || manifest.kind !== "mapache-workspace-file-state" ||
      manifest.storagePrefix !== agentSnapshotStoragePrefix(config) || manifest.workspaceId !== config.workspaceId ||
      manifest.sessionId !== config.sessionId) {
    throw checkpointError("checkpoint_previous_manifest_invalid", "Published workspace manifest does not match the workspace");
  }
  return manifest;
}

async function recordCheckpointError({
  admin,
  bootInstanceId,
  config = {},
  db,
  errorCode,
  generation,
  now = () => Date.now(),
  sessionId,
  workspaceId,
} = {}) {
  const safeCode = normalizeErrorCode(errorCode);
  const identity = validateIdentity({
    bootInstanceId: bootInstanceId || config.agentRuntimeBootInstanceId,
    generation: generation || config.agentRuntimeGeneration,
    sessionId: sessionId || config.sessionId,
    workspaceId: workspaceId || config.workspaceId,
  });
  const timestamp = serverTimestamp(admin, now);
  const workspaceRef = workspaceDocument(db, identity.workspaceId);
  const sessionRef = sessionDocument(workspaceRef, identity.sessionId);
  await db.runTransaction(async (transaction) => {
    const [workspaceSnap, sessionSnap] = await Promise.all([
      transaction.get(workspaceRef),
      transaction.get(sessionRef),
    ]);
    if (!workspaceSnap.exists || !sessionSnap.exists) throw checkpointError("checkpoint_writer_not_current", "Checkpoint authority documents are missing");
    assertCurrentAuthority(workspaceSnap.data() || {}, sessionSnap.data() || {}, identity);
    const updates = {agentRuntimeCheckpointError: safeCode, agentRuntimeCheckpointErrorAt: timestamp};
    if (!isAutomationRuntime(config)) transaction.update(workspaceRef, updates);
    transaction.update(sessionRef, updates);
  });
  return {ok: true, checkpointError: safeCode};
}

async function getCheckpointStatus({config = {}, db} = {}) {
  const fallback = {lastCheckpointAt: null, checkpointError: null};
  if (!db || typeof db.collection !== "function" || !config.workspaceId || !config.sessionId) return fallback;
  const workspaceRef = workspaceDocument(db, config.workspaceId);
  const sessionRef = sessionDocument(workspaceRef, config.sessionId);
  if (typeof sessionRef.get !== "function") return fallback;
  try {
    const snapshot = await sessionRef.get();
    if (!snapshot?.exists) return fallback;
    const data = snapshot.data() || {};
    return {
      lastCheckpointAt: safeTimestampValue(data.agentRuntimeLastCheckpointAt),
      checkpointError: data.agentRuntimeCheckpointError ? normalizeErrorCode(data.agentRuntimeCheckpointError) : null,
    };
  } catch (_error) {
    // Health/status endpoints must never expose Firestore errors or raw runner
    // details. The next successful checkpoint will refresh this view.
    return fallback;
  }
}

async function collectWorkspaceFiles({fsImpl, root, shouldIgnore}) {
  if (!root) return [];
  const resolvedRoot = path.resolve(root);
  const rootStat = await fsImpl.promises.lstat(resolvedRoot);
  if (!rootStat.isDirectory()) throw checkpointError("checkpoint_workspace_invalid", "Workspace root is not a directory");
  const files = [];
  await walkWorkspace({fsImpl, root: resolvedRoot, currentDir: resolvedRoot, files, shouldIgnore});
  return files;
}

async function walkWorkspace({fsImpl, root, currentDir, files, shouldIgnore}) {
  const entries = await fsImpl.promises.readdir(currentDir, {withFileTypes: true});
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const localPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(root, localPath).split(path.sep).join("/");
    if (shouldIgnore(relativePath)) continue;
    const stat = await fsImpl.promises.lstat(localPath);
    if (stat.isDirectory()) {
      await walkWorkspace({fsImpl, root, currentDir: localPath, files, shouldIgnore});
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = await fsImpl.promises.readlink(localPath);
      if (path.isAbsolute(target)) throw checkpointError("checkpoint_unsafe_symlink", `Workspace symlink is absolute: ${relativePath}`);
      const targetPath = path.resolve(path.dirname(localPath), target);
      if (!isPathInside(root, targetPath)) throw checkpointError("checkpoint_unsafe_symlink", `Workspace symlink escapes root: ${relativePath}`);
      const targetRealPath = await fsImpl.promises.realpath(targetPath);
      const rootRealPath = await fsImpl.promises.realpath(root);
      if (!isPathInside(rootRealPath, targetRealPath)) throw checkpointError("checkpoint_unsafe_symlink", `Workspace symlink resolves outside root: ${relativePath}`);
      files.push({kind: "symlink", mode: stat.mode & 0o777, path: relativePath, target});
      continue;
    }
    if (stat.isFile()) files.push({kind: "workspace-file", localPath, mode: stat.mode & 0o777, path: relativePath});
  }
}

async function writeImmutableObject({
  bucketName,
  content,
  contentType,
  localPath,
  metadata,
  objectPath,
  storage,
  uploadObject,
} = {}) {
  if (!bucketName) throw checkpointError("checkpoint_storage_unavailable", "Checkpoint bucket is not configured");
  const options = {
    ...generationMatchOptions(0),
    metadata: {
      contentType,
      metadata: {...metadata, mapacheImmutable: "1"},
    },
    resumable: false,
  };
  if (typeof uploadObject === "function") {
    await uploadObject({bucketName, content, localPath, objectPath, options});
    return;
  }
  const bucket = storage.bucket(bucketName);
  if (content !== undefined) {
    await bucket.file(objectPath).save(content, options);
    return;
  }
  await bucket.upload(localPath, {...options, destination: objectPath});
}

function normalizeCapture(capture) {
  if (!capture || typeof capture !== "object" || !capture.manifest) {
    throw checkpointError("checkpoint_capture_invalid", "Task 14 capture is required");
  }
  if (!capture.stagingDir) throw checkpointError("checkpoint_capture_invalid", "Capture staging directory is required");
  return {manifest: capture.manifest, stagingDir: path.resolve(capture.stagingDir)};
}

function validateManifest(manifest, config) {
  if (manifest.manifestVersion !== CHECKPOINT_VERSION || manifest.kind !== "mapache-agent-state-snapshot") {
    throw checkpointError("checkpoint_manifest_unsupported", "Unsupported agent snapshot manifest");
  }
  const expectedPrefix = agentSnapshotStoragePrefix(config);
  if (!expectedPrefix || manifest.storagePrefix !== expectedPrefix) {
    throw checkpointError("checkpoint_manifest_namespace_invalid", "Snapshot manifest namespace does not match the workspace");
  }
  return validateIdentity(manifest);
}

function validateIdentity({bootInstanceId, generation, sessionId, workspaceId}) {
  const cleanGeneration = Number(generation);
  const identity = {
    bootInstanceId: String(bootInstanceId || "").trim(),
    generation: cleanGeneration,
    sessionId: String(sessionId || "").trim(),
    workspaceId: String(workspaceId || "").trim(),
  };
  if (!identity.bootInstanceId || !Number.isInteger(cleanGeneration) || cleanGeneration <= 0 ||
      !identity.sessionId || !identity.workspaceId) {
    throw checkpointError("checkpoint_identity_missing", "Checkpoint identity is incomplete");
  }
  return identity;
}

function assertCurrentAuthority(workspace, session, identity) {
  if (workspace.deleted === true || ["deleting", "deleted"].includes(
      String(workspace.lifecycle || workspace.status || "").trim().toLowerCase(),
  )) {
    throw checkpointError("checkpoint_workspace_deleted", "Workspace deletion has revoked checkpoint publication");
  }
  if (workspace.agentUiVersion !== "pi-web-ui-v1" || session.agentUiVersion !== "pi-web-ui-v1") {
    throw checkpointError("checkpoint_writer_not_current", "Checkpoint writer is not a managed runtime");
  }
  const automationRuntime = isAutomationRuntime(session);
  if (automationRuntime) {
    if (String(session.runtimeKind || "").trim().toLowerCase() !== "automation" ||
        String(session.agentRuntimeSessionId || "") !== identity.sessionId ||
        Number(session.agentRuntimeGeneration) !== identity.generation ||
        String(session.agentRuntimeBootInstanceId || "") !== identity.bootInstanceId ||
        String(session.agentRuntimeAuthorityState || "").toLowerCase() !== "admitted") {
      throw checkpointError("checkpoint_writer_not_current", "Checkpoint writer authority is stale");
    }
    return;
  }
  if (String(workspace.agentRuntimeSessionId || "") !== identity.sessionId ||
      Number(workspace.agentRuntimeGeneration) !== identity.generation ||
      Number(session.agentRuntimeGeneration) !== identity.generation ||
      String(workspace.agentRuntimeBootInstanceId || "") !== identity.bootInstanceId ||
      String(session.agentRuntimeBootInstanceId || "") !== identity.bootInstanceId ||
      String(workspace.agentRuntimeAuthorityState || "").toLowerCase() !== "admitted" ||
      String(session.agentRuntimeAuthorityState || "").toLowerCase() !== "admitted") {
    throw checkpointError("checkpoint_writer_not_current", "Checkpoint writer authority is stale");
  }
}

function verifyContent(file, content, relativePath) {
  if (Number(file.byteLength) !== content.length || String(file.sha256 || "") !== sha256(content)) {
    throw checkpointError("checkpoint_capture_changed", `Captured checksum mismatch: ${relativePath}`);
  }
}

function objectReference({bucketName, content, objectPath}) {
  return {
    bucketName,
    byteLength: content.length,
    objectPath,
    sha256: sha256(content),
  };
}

function safeObjectReference(reference) {
  return {
    bucketName: String(reference.bucketName || ""),
    byteLength: Number(reference.byteLength),
    objectPath: String(reference.objectPath || ""),
    sha256: String(reference.sha256 || ""),
  };
}

function resolveStagingPath(root, relativePath) {
  if (!root) throw checkpointError("checkpoint_capture_invalid", "Capture staging directory is required");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  if (!isPathInside(resolvedRoot, resolved)) throw checkpointError("checkpoint_path_traversal", "Checkpoint path escapes staging");
  return resolved;
}

function validateRelativePath(value, label) {
  const relative = String(value || "").replace(/\\/g, "/");
  const normalized = path.posix.normalize(relative);
  if (!relative || relative.startsWith("/") || normalized !== relative || normalized === "." ||
      normalized === ".." || normalized.startsWith("../") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw checkpointError("checkpoint_path_traversal", `Unsafe ${label} path`);
  }
  return relative;
}

function workspaceDocument(db, workspaceId) {
  return db.collection("workspaces").doc(workspaceId);
}

function sessionDocument(workspaceRef, sessionId) {
  return workspaceRef.collection("sessions").doc(sessionId);
}

function serverTimestamp(admin, now) {
  if (admin?.firestore?.FieldValue?.serverTimestamp) return admin.firestore.FieldValue.serverTimestamp();
  return {__serverTimestamp: toIsoTimestamp(now())};
}

function normalizeErrorCode(value) {
  const code = String(value || "checkpoint_failed").trim().toLowerCase();
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : "checkpoint_failed";
}

function cleanRemoteSegment(value) {
  const segment = String(value || "").trim().replace(/[^A-Za-z0-9._-]/g, "-");
  if (!segment || segment === "." || segment === "..") return "unknown";
  return segment.slice(0, 160);
}

function isPathInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw checkpointError("checkpoint_timestamp_invalid", "Checkpoint timestamp is invalid");
  return date.toISOString();
}

function safeTimestampValue(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return toIsoTimestamp(value.toDate());
  try {
    return toIsoTimestamp(value);
  } catch (_error) {
    return null;
  }
}

function checkpointError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function injectPublicationFailure(faultHarness) {
  if (typeof faultHarness?.enabled !== "function" || !faultHarness.enabled()) return;
  if (await faultHarness.consume("storage-publication")) {
    throw checkpointError(
        "qa_injected_storage_publication_failure",
        "QA fault harness injected a storage publication failure",
    );
  }
}

module.exports = {
  CHECKPOINT_VERSION,
  WORKSPACE_FILE_NAMESPACE,
  assertCurrentAuthority,
  commitCheckpoint,
  createAgentCheckpointService,
  publishWorkspaceFiles,
  recordCheckpointError,
  uploadCapture,
  validateRelativePath,
};
