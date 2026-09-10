"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {pipeline} = require("node:stream/promises");
const {collectStderr, waitForChild} = require("./processes");

const CHECKPOINT_SCHEMA_VERSION = 1;
const DEFAULT_BARRIER_TIMEOUT_MS = 15_000;
const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const PAYLOADS = Object.freeze([
  ["pi-session.jsonl", "application/jsonl"],
  ["managed-goal-state.json", "application/json"],
  ["workspace-snapshot.tar.gz", "application/gzip"],
  ["operation-evidence.json", "application/json"],
]);

/**
 * Captures and publishes the pi-chrome recovery pair. Uploads are immutable;
 * the Firestore transaction is the only operation that changes the committed
 * recovery pointer. The service intentionally has no "newest object" fallback.
 */
function createWorkspaceCheckpointService({
  admin,
  config = {},
  db,
  storage,
  authority,
  barrier,
  ledger,
  adapter,
  goals,
  isQuiescent,
  fsModule = fs,
  spawnImpl = spawn,
  randomUUID = crypto.randomUUID,
  now = () => Date.now(),
  logger = console,
  barrierTimeoutMs = DEFAULT_BARRIER_TIMEOUT_MS,
  orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS,
} = {}) {
  const enabled = Boolean(config.webFirstEnabled);
  const workspaceId = String(config.workspaceId || "").trim();
  const sessionId = String(config.sessionId || "").trim();
  let inFlight = null;
  let lastResult = null;
  let lastError = null;
  let blocked = false;

  return {
    assertMutationAllowed,
    create,
    ensureInitial,
    enabled,
    cleanupOrphans,
    restore,
    status,
    verifyRecovery,
  };

  async function ensureInitial() {
    if (!enabled) return {enabled: false, skipped: true};
    const current = await readCurrentRecovery().catch((error) => {
      lastError = safeError(error);
      return null;
    });
    if (current?.checkpointId) return {ok: true, existing: true, recovery: current};
    return create({kind: "initial"});
  }

  async function create(options = {}) {
    if (!enabled) return {enabled: false, skipped: true};
    if (inFlight) return inFlight;
    if (!authority?.canMutate?.()) throw checkpointError("execution_authority_required");
    inFlight = performCreate(options).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function assertMutationAllowed(options = {}) {
    if (!enabled) return {enabled: false, allowed: true};
    authority?.assertAuthority?.();
    if (options.requireSession && !String(adapter?.identity?.()?.piSession || "").trim()) {
      throw checkpointError("checkpoint_pi_identity_missing");
    }
    if (typeof isQuiescent === "function" && !await isQuiescent()) {
      throw checkpointError("checkpoint_active_execution");
    }
    return {enabled: true, allowed: true};
  }

  async function performCreate(options = {}) {
    let barrierClosed = false;
    let tempRoot = null;
    const checkpointId = cleanId(options.checkpointId) || `cp-${now()}-${randomUUID().slice(0, 8)}`;
    try {
      authority.assertAuthority();
      if (!options.allowActiveRun) await assertMutationAllowed();
      await barrier?.begin?.({reason: `checkpoint:${checkpointId}`, timeoutMs: options.barrierTimeoutMs || barrierTimeoutMs});
      barrierClosed = Boolean(barrier);
      authority.assertAuthority();
      tempRoot = await fsModule.promises.mkdtemp(path.join(os.tmpdir(), "mapache-checkpoint-"));

      const previous = await readCurrentRecovery();
      const capture = await capturePayloads(tempRoot, checkpointId, options);
      const manifest = buildManifest({
        checkpointId,
        capture,
        previous,
        options,
      });
      const uploaded = await uploadCheckpoint(tempRoot, checkpointId, manifest);
      authority.assertAuthority();
      const recovery = await publishManifest(manifest, uploaded.manifest);
      for (const operation of ledger?.list?.() || []) {
        await ledger.setDurability(operation.commandId, "checkpoint_committed").catch((error) => {
          logger.warn?.("operation durability update failed after checkpoint", {commandId: operation.commandId, error: safeError(error)});
        });
      }
      blocked = false;
      lastError = null;
      lastResult = {
        ok: true,
        checkpointId,
        recovery,
        manifest,
        uploaded,
      };
      barrier?.reopen?.();
      return lastResult;
    } catch (error) {
      lastError = safeError(error);
      blocked = true;
      barrier?.block?.(error.code || "checkpoint_failed");
      throw error;
    } finally {
      if (tempRoot) await fsModule.promises.rm(tempRoot, {recursive: true, force: true}).catch(() => {});
      if (!barrierClosed && barrier && blocked) barrier.block(lastError || "checkpoint_failed");
    }
  }

  async function capturePayloads(tempRoot, checkpointId, options) {
    const initial = String(options.kind || "") === "initial";
    const session = initial ? {
      source: "mapache-initial-checkpoint",
      checkpointSchemaVersion: CHECKPOINT_SCHEMA_VERSION,
      workspaceId,
      sessionId,
    } : await capturePiSession();
    await writeJson(path.join(tempRoot, "managed-goal-state.json"), await safeGoalSnapshot(), fsModule);
    await writeJson(path.join(tempRoot, "operation-evidence.json"), {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpointId,
      ...(ledger?.snapshot?.() || {operations: [], events: []}),
    }, fsModule);
    await createWorkspaceArchive(path.join(tempRoot, "workspace-snapshot.tar.gz"), {
      workspaceDir: config.workspaceDir,
      fsModule,
      spawnImpl,
    });
    await fsModule.promises.writeFile(path.join(tempRoot, "pi-session.jsonl"), `${initial ? `${JSON.stringify(session)}\n` : session.source}`);
    return {
      initial,
      piSessionId: initial ? null : session.piSessionId,
      sessionFileRelativePath: initial ? null : session.sessionFileRelativePath,
      leafId: initial ? null : session.leafId,
      workspaceEntries: session.workspaceEntries,
      goalStatePath: "managed-goal-state.json",
      operationEvidencePath: "operation-evidence.json",
    };
  }

  async function capturePiSession() {
    const identity = adapter?.identity?.();
    const piSessionId = String(identity?.piSession || "").trim();
    if (!piSessionId) throw checkpointError("checkpoint_pi_identity_missing");
    const sessionRoot = String(config.piSessionDir || "").trim();
    const configuredPath = String(config.piSessionJsonlPath || "").trim();
    const configuredFile = configuredPath && isWithin(sessionRoot, configuredPath) ? {path: configuredPath} : null;
    const file = configuredFile || await findLatestJsonl(sessionRoot, fsModule);
    if (!file) throw checkpointError("checkpoint_pi_session_missing");
    const stable = await readStableText(file.path, {fsModule});
    const tree = validateSessionTree(stable.source);
    if (tree.leafId === null) throw checkpointError("checkpoint_active_leaf_missing");
    return {
      source: stable.source,
      piSessionId,
      sessionFileRelativePath: path.relative(config.piSessionDir, file.path).split(path.sep).join("/"),
      leafId: tree.leafId,
    };
  }

  async function safeGoalSnapshot() {
    if (typeof goals?.snapshot !== "function") return {ok: false, error: "goal_snapshot_unavailable", goals: []};
    try {
      return await goals.snapshot();
    } catch (error) {
      return {ok: false, error: safeError(error), goals: []};
    }
  }

  function buildManifest({checkpointId, capture, previous, options}) {
    const authoritySnapshot = authority.snapshot();
    const workspaceRevision = Number(previous?.workspaceRevision || 0) + 1;
    return {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpointId,
      kind: capture.initial ? "initial" : "runtime",
      workspaceId,
      sessionId,
      priorCheckpointId: previous?.checkpointId || null,
      priorManifestGeneration: previous?.manifestGeneration || null,
      workspaceRevision,
      executionEpoch: authoritySnapshot.executionEpoch,
      runtimeId: authoritySnapshot.runtimeId,
      piSessionId: capture.piSessionId,
      sessionFileRelativePath: capture.sessionFileRelativePath,
      leafId: capture.leafId,
      runtimeVersion: process.version,
      adapter: safeAdapterIdentity(adapter),
      packageVersion: String(process.env.PI_GOAL_X_VERSION || "").slice(0, 128) || null,
      snapshotScope: {
        workspace: "allowlist-v1",
        excluded: [
          "credentials and control tokens",
          "IPC sockets and control files",
          "node_modules and Pi package caches",
          "Chrome profile and browser caches",
          "workspace internal archive paths",
        ],
        included: ["workspace files", "Git worktree metadata when present", "Pi session tree", "managed goal state", "operation evidence"],
      },
      options: {reason: String(options.reason || options.kind || "manual").slice(0, 128)},
      objects: [],
    };
  }

  async function uploadCheckpoint(tempRoot, checkpointId, manifest) {
    const prefix = checkpointPrefix(checkpointId, manifest.executionEpoch);
    if (!prefix) throw checkpointError("checkpoint_storage_prefix_missing");
    const objects = [];
    for (const [fileName, contentType] of PAYLOADS) {
      const localPath = path.join(tempRoot, fileName);
      const receipt = await uploadImmutable(localPath, `${prefix}/${fileName}`, contentType);
      objects.push(receipt);
    }
    manifest.objects = objects.map((object) => ({...object}));
    const manifestPath = path.join(tempRoot, "manifest.json");
    await writeJson(manifestPath, manifest);
    const manifestReceipt = await uploadImmutable(manifestPath, `${prefix}/manifest.json`, "application/json");
    return {prefix, objects, manifest: manifestReceipt};
  }

  async function uploadImmutable(localPath, remoteName, contentType) {
    const file = storage?.bucket?.(checkpointBucket()).file(remoteName);
    if (!file) throw checkpointError("checkpoint_storage_unavailable");
    const hash = await hashFile(localPath);
    const metadata = {
      contentType,
      metadata: {
        mapacheCheckpointSchema: String(CHECKPOINT_SCHEMA_VERSION),
        mapacheCheckpointSha256: hash.sha256,
      },
    };
    try {
      if (typeof file.createWriteStream === "function") {
        await pipeline(
            fsModule.createReadStream(localPath),
            file.createWriteStream({...metadata, resumable: true, preconditionOpts: {ifGenerationMatch: 0}}),
        );
      } else if (typeof file.save === "function") {
        await file.save(await fsModule.promises.readFile(localPath), {...metadata, resumable: false, preconditionOpts: {ifGenerationMatch: 0}});
      } else {
        throw checkpointError("checkpoint_storage_unavailable");
      }
    } catch (error) {
      if (isAlreadyExists(error)) throw checkpointError("checkpoint_object_exists");
      throw error;
    }
    const verified = await getMetadata(file);
    if (String(verified.metadata?.mapacheCheckpointSha256 || "") !== hash.sha256 ||
        Number(verified.size || 0) !== hash.byteLength) {
      const error = checkpointError("checkpoint_object_integrity_failed");
      error.details = {name: remoteName, expected: hash, actual: {size: verified.size, sha256: verified.metadata?.mapacheCheckpointSha256 || null}};
      throw error;
    }
    return {
      name: remoteName,
      generation: String(verified.generation || ""),
      sha256: hash.sha256,
      byteLength: hash.byteLength,
      contentType,
    };
  }

  async function publishManifest(manifest, manifestReceipt) {
    requireStore();
    const refs = checkpointRefs();
    const recovery = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpointId: manifest.checkpointId,
      piSessionId: manifest.piSessionId,
      sessionFileRelativePath: manifest.sessionFileRelativePath,
      leafId: manifest.leafId,
      manifestObject: manifestReceipt.name,
      manifestGeneration: manifestReceipt.generation,
      manifestSha256: manifestReceipt.sha256,
      workspaceRevision: manifest.workspaceRevision,
      executionEpoch: manifest.executionEpoch,
      runtimeId: manifest.runtimeId,
      priorCheckpointId: manifest.priorCheckpointId,
      committedAt: admin?.firestore?.FieldValue?.serverTimestamp?.() || new Date(now()),
    };
    await db.runTransaction(async (transaction) => {
      const sessionSnap = await transaction.get(refs.sessionRef);
      const workspaceSnap = await transaction.get(refs.workspaceRef);
      if (!sessionSnap.exists || !workspaceSnap.exists) throw checkpointError("checkpoint_workspace_missing");
      const session = sessionSnap.data() || {};
      const workspace = workspaceSnap.data() || {};
      assertPublicationAuthority(workspace, session, manifest);
      const current = session.recovery || null;
      if ((current?.checkpointId || null) !== (manifest.priorCheckpointId || null)) {
        throw checkpointError("checkpoint_previous_pointer_conflict");
      }
      if (Number(current?.workspaceRevision || 0) + 1 !== manifest.workspaceRevision) {
        throw checkpointError("checkpoint_workspace_revision_conflict");
      }
      transaction.set(refs.sessionRef, {
        recovery,
        checkpoint: {
          checkpointId: manifest.checkpointId,
          workspaceRevision: manifest.workspaceRevision,
          state: "committed",
          manifestObject: manifestReceipt.name,
          manifestGeneration: manifestReceipt.generation,
          updatedAt: recovery.committedAt,
        },
        checkpointState: "committed",
        workspaceRevision: manifest.workspaceRevision,
      }, {merge: true});
      transaction.set(refs.workspaceRef, {
        recovery: {
          ...recovery,
          sessionId,
        },
      }, {merge: true});
    });
    return recovery;
  }

  async function verifyRecovery(pointer) {
    const recovery = pointer || await readCurrentRecovery();
    if (!recovery?.manifestObject || !recovery.manifestGeneration || !recovery.manifestSha256) {
      throw checkpointError("checkpoint_recovery_missing");
    }
    const downloaded = await downloadVerified(recovery.manifestObject, recovery.manifestGeneration, recovery.manifestSha256);
    const manifest = JSON.parse(downloaded.source);
    validateManifest(manifest, recovery);
    for (const object of manifest.objects) {
      await verifyRemoteObject(object);
    }
    return {ok: true, recovery, manifest};
  }

  async function restore(options = {}) {
    const verified = await verifyRecovery(options.recovery);
    const destination = path.resolve(options.destinationWorkspaceDir || `${config.workspaceDir}.restore-${verified.manifest.checkpointId}`);
    assertRestoreDestination(destination);
    await fsModule.promises.mkdir(destination, {recursive: true});
    const workspaceObject = verified.manifest.objects.find((object) => object.name.endsWith("/workspace-snapshot.tar.gz"));
    const sessionObject = verified.manifest.objects.find((object) => object.name.endsWith("/pi-session.jsonl"));
    if (!workspaceObject || !sessionObject) throw checkpointError("checkpoint_payload_missing");
    const root = await fsModule.promises.mkdtemp(path.join(os.tmpdir(), "mapache-restore-"));
    try {
      const archivePath = path.join(root, "workspace-snapshot.tar.gz");
      const sessionPath = path.join(root, "pi-session.jsonl");
      await downloadTo(workspaceObject, archivePath);
      await downloadTo(sessionObject, sessionPath);
      if (verified.manifest.kind !== "initial") {
        const tree = validateSessionTree(await fsModule.promises.readFile(sessionPath, "utf8"));
        if (tree.leafId !== verified.manifest.leafId) throw checkpointError("checkpoint_active_leaf_mismatch");
      }
      await extractArchive(archivePath, destination);
      const sessionDir = path.join(destination, ".mapache-restore");
      await fsModule.promises.mkdir(sessionDir, {recursive: true});
      await fsModule.promises.copyFile(sessionPath, path.join(sessionDir, "pi-session.jsonl"));
      return {
        ok: true,
        checkpointId: verified.manifest.checkpointId,
        destinationWorkspaceDir: destination,
        sessionPath: path.join(sessionDir, "pi-session.jsonl"),
        appliedToLiveWorkspace: false,
      };
    } finally {
      await fsModule.promises.rm(root, {recursive: true, force: true}).catch(() => {});
    }
  }

  async function cleanupOrphans(options = {}) {
    requireStore();
    if (inFlight) throw checkpointError("checkpoint_cleanup_in_progress");
    const bucket = storage.bucket(checkpointBucket());
    const prefix = checkpointRoot();
    const [files] = await bucket.getFiles({prefix: `${prefix}/epochs/`});
    const cutoff = now() - Number(options.graceMs || orphanGraceMs);
    const protectedNames = await protectedObjectNames();
    const deleted = [];
    for (const file of files || []) {
      const metadata = await getMetadata(file).catch(() => null);
      if (!metadata || protectedNames.has(file.name)) continue;
      const updated = Date.parse(metadata.updated || metadata.timeCreated || "");
      if (!Number.isFinite(updated) || updated > cutoff) continue;
      await file.delete({ignoreNotFound: true, ifGenerationMatch: metadata.generation});
      deleted.push(file.name);
    }
    return {ok: true, deleted, protected: protectedNames.size};
  }

  async function protectedObjectNames() {
    const result = new Set();
    const pointer = await readCurrentRecovery().catch(() => null);
    if (!pointer) return result;
    result.add(pointer.manifestObject);
    try {
      const verified = await verifyRecovery(pointer);
      for (const object of verified.manifest.objects) result.add(object.name);
    } catch (error) {
      logger.warn?.("checkpoint cleanup could not verify current pointer", {error: safeError(error)});
    }
    return result;
  }

  async function readCurrentRecovery() {
    requireStore();
    const snap = await checkpointRefs().sessionRef.get();
    return snap.exists ? snap.data()?.recovery || null : null;
  }

  function status() {
    return {
      enabled,
      inFlight: Boolean(inFlight),
      blocked,
      lastError,
      lastResult: lastResult ? {
        ok: lastResult.ok,
        checkpointId: lastResult.checkpointId,
        recovery: lastResult.recovery,
      } : null,
    };
  }

  function checkpointRoot() {
    const base = String(config.piSessionStoragePrefix || "").replace(/\/+$/, "");
    return base;
  }

  function checkpointPrefix(checkpointId, epoch) {
    const root = checkpointRoot();
    if (!root) return "";
    return `${root}/epochs/${encodeSegment(epoch)}/checkpoints/${encodeSegment(checkpointId)}`;
  }

  function checkpointBucket() {
    return String(config.piSessionStorageBucket || config.bucketName || "").trim();
  }

  function checkpointRefs() {
    requireStore();
    const workspaceRef = db.collection("workspaces").doc(workspaceId);
    return {workspaceRef, sessionRef: workspaceRef.collection("sessions").doc(sessionId)};
  }

  function requireStore() {
    if (!db || !storage || !workspaceId || !sessionId) throw checkpointError("checkpoint_store_unavailable");
  }

  function assertRestoreDestination(destination) {
    const configuredWorkspace = String(config.workspaceDir || "").trim();
    if (!configuredWorkspace) return;
    const liveWorkspace = path.resolve(configuredWorkspace);
    const relative = path.relative(liveWorkspace, destination);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw checkpointError("checkpoint_restore_destination_invalid");
    }
  }

  function assertPublicationAuthority(workspace, session, manifest) {
    const current = workspace.executionAuthority || {};
    if (String(current.state || "") !== "active" || String(current.runtimeId || "") !== manifest.runtimeId ||
        Number(current.executionEpoch || 0) !== Number(manifest.executionEpoch || 0) ||
        String(current.sessionId || "") !== sessionId) throw checkpointError("checkpoint_authority_stale");
    if (String(session.syncWriterRole || "") !== "writer" || String(workspace.syncWriterSessionId || "") !== sessionId ||
        String(session.syncWriterLeaseId || "") !== String(workspace.syncWriterLeaseId || "")) {
      throw checkpointError("checkpoint_writer_reservation_stale");
    }
  }

  async function downloadVerified(name, generation, sha256) {
    const file = storage.bucket(checkpointBucket()).file(name);
    const metadata = await getMetadata(file);
    if (String(metadata.generation || "") !== String(generation)) throw checkpointError("checkpoint_generation_mismatch");
    const root = await fsModule.promises.mkdtemp(path.join(os.tmpdir(), "mapache-checkpoint-download-"));
    const target = path.join(root, "object");
    try {
      await downloadFile(file, target);
      const hash = await hashFile(target, fsModule);
      if (hash.sha256 !== String(sha256)) throw checkpointError("checkpoint_checksum_mismatch");
      return {source: await fsModule.promises.readFile(target, "utf8"), metadata};
    } finally {
      await fsModule.promises.rm(root, {recursive: true, force: true}).catch(() => {});
    }
  }

  async function verifyRemoteObject(object) {
    const file = storage.bucket(checkpointBucket()).file(object.name);
    const metadata = await getMetadata(file);
    if (String(metadata.generation || "") !== String(object.generation)) throw checkpointError("checkpoint_generation_mismatch");
    if (Number(metadata.size || 0) !== Number(object.byteLength)) throw checkpointError("checkpoint_length_mismatch");
    const root = await fsModule.promises.mkdtemp(path.join(os.tmpdir(), "mapache-checkpoint-verify-"));
    const target = path.join(root, "object");
    try {
      await downloadFile(file, target);
      const hash = await hashFile(target, fsModule);
      if (hash.sha256 !== String(object.sha256)) throw checkpointError("checkpoint_checksum_mismatch");
    } finally {
      await fsModule.promises.rm(root, {recursive: true, force: true}).catch(() => {});
    }
  }

  async function downloadTo(object, target) {
    const file = storage.bucket(checkpointBucket()).file(object.name);
    const metadata = await getMetadata(file);
    if (String(metadata.generation || "") !== String(object.generation)) throw checkpointError("checkpoint_generation_mismatch");
    await downloadFile(file, target);
    const hash = await hashFile(target, fsModule);
    if (hash.sha256 !== String(object.sha256) || hash.byteLength !== Number(object.byteLength)) {
      throw checkpointError("checkpoint_checksum_mismatch");
    }
  }

  async function extractArchive(archivePath, destination) {
    const child = spawnImpl("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", archivePath, "-C", destination], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = collectStderr(child);
    await waitForChild(child, stderr, "restore workspace checkpoint");
  }
}

async function createWorkspaceArchive(destination, options = {}) {
  const root = path.resolve(options.workspaceDir || options.config?.workspaceDir || "/workspace");
  const fileSystem = options.fsModule || fs;
  const entries = await collectWorkspaceEntries(root, fileSystem);
  const child = (options.spawnImpl || spawn)("tar", ["--no-recursion", "--null", "-czf", destination, "-C", root, "--files-from", "-"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stdin.end(Buffer.from(`${entries.join("\0")}${entries.length ? "\0" : ""}`));
  const stderr = collectStderr(child);
  await waitForChild(child, stderr, "checkpoint workspace archive");
}

async function collectWorkspaceEntries(root, fileSystem = fs) {
  const entries = [];
  async function visit(directory, relativeDirectory) {
    let children;
    try {
      children = await fileSystem.promises.readdir(directory, {withFileTypes: true});
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (shouldExcludeWorkspacePath(relative, child)) continue;
      const local = path.join(directory, child.name);
      if (child.isDirectory()) {
        entries.push(`./${relative}`);
        await visit(local, relative);
      } else if (child.isFile()) {
        entries.push(`./${relative}`);
      }
    }
  }
  await visit(root, "");
  return entries.sort();
}

function shouldExcludeWorkspacePath(relative, entry) {
  const parts = relative.split("/");
  const name = parts.at(-1) || "";
  if (entry.isSymbolicLink?.() || parts.includes("node_modules") || parts.includes(".cache") || parts.includes(".npm")) return true;
  if (parts[0] === ".mapache-internal" || parts[0] === ".mapahce-internal") return true;
  if (parts[0] === ".pi" && ["npm", "git", "agent"].includes(parts[1])) return true;
  if (name === ".env" || name.startsWith(".env.") || name === "auth.json" || name === "credentials.json") return true;
  if (name === "hosts.yml" && parts.includes(".config") && parts.includes("gh")) return true;
  if (["id_rsa", "id_ed25519", "known_hosts"].includes(name) || /\.(pem|key|p12|pfx)$/i.test(name)) return true;
  if (name.endsWith(".lock") && parts[0] === ".git") return true;
  return false;
}

async function findLatestJsonl(root, fileSystem = fs) {
  if (!root) return null;
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fileSystem.promises.readdir(directory, {withFileTypes: true});
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const local = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(local);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = await fileSystem.promises.stat(local);
        files.push({path: local, mtimeMs: stat.mtimeMs});
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

async function readStableText(filePath, options = {}) {
  const attempts = Number(options.attempts || 3);
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const fileSystem = options.fsModule || fs;
    const before = await fileSystem.promises.stat(filePath);
    const source = await fileSystem.promises.readFile(filePath, "utf8");
    const after = await fileSystem.promises.stat(filePath);
    if (before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return {source, stat: after};
    }
    last = {before, after};
  }
  const error = new Error("checkpoint_transcript_mutated_during_capture");
  error.code = "checkpoint_transcript_mutated_during_capture";
  error.details = last;
  throw error;
}

function validateSessionTree(source) {
  const records = [];
  for (const line of String(source || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw checkpointError("checkpoint_session_json_invalid");
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) throw checkpointError("checkpoint_session_record_invalid");
    records.push(record);
  }
  const byId = new Map();
  const children = new Set();
  for (const record of records) {
    const id = stableId(record.id || record.entryId);
    if (!id) continue;
    if (byId.has(id)) throw checkpointError("checkpoint_session_duplicate_id");
    byId.set(id, record);
    const parentId = stableId(record.parentId);
    if (parentId) children.add(parentId);
  }
  for (const parentId of children) if (!byId.has(parentId)) throw checkpointError("checkpoint_session_parent_missing");
  const leaf = [...byId.keys()].reverse().find((id) => !children.has(id));
  return {leafId: leaf || null, recordCount: records.length};
}

function stableId(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function isWithin(root, candidate) {
  const resolvedRoot = path.resolve(String(root || "").trim());
  const resolvedCandidate = path.resolve(String(candidate || "").trim());
  if (!resolvedRoot || !resolvedCandidate || resolvedRoot === "." || resolvedCandidate === ".") return false;
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function writeJson(filePath, value, fileSystem = fs) {
  await fileSystem.promises.writeFile(filePath, `${JSON.stringify(value)}\n`, {mode: 0o600});
}

async function hashFile(filePath, fileSystem = fs) {
  const hash = crypto.createHash("sha256");
  let byteLength = 0;
  for await (const chunk of fileSystem.createReadStream(filePath)) {
    byteLength += chunk.length;
    hash.update(chunk);
  }
  return {sha256: hash.digest("hex"), byteLength};
}

async function getMetadata(file) {
  const [metadata] = await file.getMetadata();
  return metadata || {};
}

async function downloadFile(file, target) {
  if (typeof file.download !== "function") throw checkpointError("checkpoint_download_unavailable");
  await file.download({destination: target});
}

function validateManifest(manifest, recovery) {
  if (!manifest || manifest.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || manifest.checkpointId !== recovery.checkpointId) {
    throw checkpointError("checkpoint_manifest_invalid");
  }
  if (String(manifest.executionEpoch) !== String(recovery.executionEpoch) ||
      String(manifest.runtimeId) !== String(recovery.runtimeId)) throw checkpointError("checkpoint_manifest_binding_invalid");
  const expectedNames = new Set(PAYLOADS.map(([name]) => name));
  const objectBasenames = new Set((manifest.objects || []).map((object) => path.basename(String(object.name || ""))));
  if (!Array.isArray(manifest.objects) || manifest.objects.length !== expectedNames.size ||
      objectBasenames.size !== manifest.objects.length ||
      [...expectedNames].some((name) => !objectBasenames.has(name))) {
    throw checkpointError("checkpoint_manifest_objects_invalid");
  }
  for (const object of manifest.objects) {
    if (!object.name || !object.generation || !/^[a-f0-9]{64}$/.test(String(object.sha256)) ||
        !Number.isSafeInteger(Number(object.byteLength)) || Number(object.byteLength) < 0) {
        throw checkpointError("checkpoint_manifest_object_invalid");
    }
    if (!String(object.name).includes(`/epochs/${manifest.executionEpoch}/checkpoints/${manifest.checkpointId}/`)) {
      throw checkpointError("checkpoint_manifest_object_binding_invalid");
    }
  }
}

function safeAdapterIdentity(adapter) {
  const identity = adapter?.identity?.() || {};
  return {
    protocol: String(identity.protocol || adapter?.protocol || "").slice(0, 128) || null,
    revision: String(identity.adapter || adapter?.adapterRevision || "").slice(0, 128) || null,
    package: identity.package ? {
      name: String(identity.package.name || "").slice(0, 128),
      version: String(identity.package.version || "").slice(0, 128),
    } : null,
  };
}

function cleanId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : "";
}

function encodeSegment(value) {
  const text = String(value || "");
  return /^[A-Za-z0-9._-]{1,128}$/.test(text) ? text : "invalid";
}

function isAlreadyExists(error) {
  return [6, "6", "already-exists", "ALREADY_EXISTS", 412, "412"].includes(error?.code) ||
    /precondition|already exists/i.test(String(error?.message || ""));
}

function safeError(error) {
  return String(error && (error.code || error.message) || error || "unknown_error").slice(0, 512);
}

function checkpointError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  CHECKPOINT_SCHEMA_VERSION,
  PAYLOADS,
  collectWorkspaceEntries,
  createWorkspaceArchive,
  createWorkspaceCheckpointService,
  findLatestJsonl,
  readStableText,
  validateManifest,
  validateSessionTree,
};
