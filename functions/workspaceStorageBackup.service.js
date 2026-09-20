"use strict";

const crypto = require("node:crypto");
const {admin: defaultAdmin, db: defaultDb, storage: defaultStorage} = require("./backendContext");
const {
  SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
  assertSharedBucketContract,
} = require("./workspaceSharedStorage.service");
const {httpError} = require("./backendUtils.helpers");

const RECOVERY_RESERVATION_COLLECTION = "workspaceStorageRecoveryReservations";
const RECOVERY_POINTER_FIELD = "sharedStorageRecovery";
const RECOVERY_VERSION = 1;
const RESERVATION_TTL_MS = 30 * 60 * 1000;
const ACTIVE_RUNNER_STATUSES = new Set([
  "queued", "provisioning", "running", "ready", "restarting", "resizing", "needs_service", "stopping", "cleanup_pending", "deleting",
]);

function backupError(code, status = 409, details = {}) {
  const error = httpError(status, code);
  error.code = code;
  error.publicMessage = code;
  Object.assign(error, details);
  return error;
}

function retentionPolicy() {
  return {
    softDeleteRetentionSeconds: SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
    versioningEnabled: false,
  };
}

function createWorkspaceStorageBackupService(dependencies = {}) {
  const admin = dependencies.admin || defaultAdmin;
  const db = dependencies.db || defaultDb;
  const storage = dependencies.storage || defaultStorage;
  const now = dependencies.now || (() => new Date());
  const randomId = dependencies.randomId || (() => crypto.randomUUID());
  const projectId = String(dependencies.projectId || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "").trim();
  const workspaceDocument = (workspaceId) => db.collection("workspaces").doc(workspaceId);
  const reservationDocument = (workspaceId) => db.collection(RECOVERY_RESERVATION_COLLECTION).doc(workspaceId);

  return {
    acquireMaintenanceReservation: (uid, workspaceId, options) => acquireMaintenanceReservation(uid, workspaceId, options),
    checkRetention: (uid, workspaceId, options) => checkRetention(uid, workspaceId, options),
    listRecoverableGenerations: (uid, workspaceId, options) => listRecoverableGenerations(uid, workspaceId, options),
    publishRecoveryPointer: (uid, workspaceId, reservationId, pointer) => publishRecoveryPointer(uid, workspaceId, reservationId, pointer),
    recoverTree: (uid, workspaceId, reservationId, manifest, options) => recoverTree(uid, workspaceId, reservationId, manifest, options),
    releaseMaintenanceReservation: (uid, workspaceId, reservationId, details) => releaseMaintenanceReservation(uid, workspaceId, reservationId, details),
    restoreGeneration: (uid, workspaceId, reservationId, options) => restoreGeneration(uid, workspaceId, reservationId, options),
  };

  async function acquireMaintenanceReservation(uid, workspaceId, options = {}) {
    const targetWorkspaceId = requiredId(workspaceId, "workspace_id");
    const ownerUid = requiredId(uid, "owner_uid");
    const reservationRef = reservationDocument(targetWorkspaceId);
    const timestamp = currentDate();
    let result;
    await db.runTransaction(async (transaction) => {
      const workspaceRef = workspaceDocument(targetWorkspaceId);
      const workspaceSnap = await transaction.get(workspaceRef);
      if (!workspaceSnap?.exists) throw backupError("workspace_not_found", 404);
      const workspace = {id: workspaceSnap.id || targetWorkspaceId, ...workspaceSnap.data()};
      assertOwner(workspace, ownerUid);
      assertWorkspaceAvailable(workspace);
      await assertPaused(readSessions(transaction, workspaceRef, targetWorkspaceId));
      const existingSnap = await transaction.get(reservationRef);
      const existing = existingSnap?.exists ? existingSnap.data() || {} : null;
      if (existing && existing.state === "reserved" && !isExpired(existing.expiresAt, timestamp)) {
        if (existing.ownerUid !== ownerUid) throw backupError("workspace_recovery_reservation_held", 409);
        result = publicReservation(existing);
        return;
      }
      const reservation = {
        version: RECOVERY_VERSION,
        reservationId: String(options.reservationId || randomId()).trim(),
        workspaceId: targetWorkspaceId,
        ownerUid,
        state: "reserved",
        purpose: "workspace-storage-recovery",
        reservedAt: timestamp.toISOString(),
        expiresAt: new Date(timestamp.getTime() + RESERVATION_TTL_MS).toISOString(),
        updatedAt: timestamp.toISOString(),
      };
      writeDocument(transaction, reservationRef, reservation);
      result = publicReservation(reservation);
    });
    const diagnostic = await checkRetention(ownerUid, targetWorkspaceId, {skipReservation: true});
    if (!diagnostic.compliant) throw backupError(diagnostic.errorCode || "workspace_storage_retention_drift", 409, diagnostic);
    return {...result, retention: diagnostic.retention, policy: diagnostic.policy};
  }

  async function releaseMaintenanceReservation(uid, workspaceId, reservationId, details = {}) {
    const reservation = await assertReservation(uid, workspaceId, reservationId);
    const ref = reservationDocument(workspaceId);
    const next = {
      ...reservation,
      state: "released",
      releasedAt: currentDate().toISOString(),
      updatedAt: currentDate().toISOString(),
      retention: details.retention || reservation.retention || null,
      releaseReason: String(details.reason || "operator_complete").slice(0, 120),
    };
    await ref.update(next);
    return publicReservation(next);
  }

  async function checkRetention(uid, workspaceId, options = {}) {
    const workspace = await loadWorkspace(uid, workspaceId);
    try {
      const {bucket, metadata, binding} = await validatedBucket(workspace);
      const policy = {
        ...retentionPolicy(),
        observedSoftDeleteRetentionSeconds: Number(metadata.softDeletePolicy?.retentionDurationSeconds),
        observedVersioningEnabled: metadata.versioning?.enabled === true,
      };
      const files = options.includeInventory === false ? [] : await listSoftDeletedFiles(bucket, options);
      return {
        compliant: true,
        bucketName: binding.bucketName,
        policy,
        retention: retentionSummary(files),
      };
    } catch (error) {
      return {
        compliant: false,
        bucketName: workspace.sharedStorage?.bucketName || null,
        errorCode: publicCode(error, "workspace_storage_retention_check_failed"),
        message: error.message || String(error),
        policy: retentionPolicy(),
        retention: emptyRetentionSummary(),
      };
    }
  }

  async function listRecoverableGenerations(uid, workspaceId, options = {}) {
    const reservation = await assertReservation(uid, workspaceId, options.reservationId);
    const {bucket, binding} = await validatedBucket(await loadWorkspace(uid, workspaceId));
    const files = await listSoftDeletedFiles(bucket, options);
    const result = {
      workspaceId,
      bucketName: binding.bucketName,
      reservationId: reservation.reservationId,
      policy: retentionPolicy(),
      retention: retentionSummary(files),
      objects: files.map(publicObject),
    };
    await updateReservationRetention(reservation, result.retention);
    return result;
  }

  async function restoreGeneration(uid, workspaceId, reservationId, options = {}) {
    const reservation = await assertReservation(uid, workspaceId, reservationId);
    const {bucket, binding} = await validatedBucket(await loadWorkspace(uid, workspaceId));
    const objectPath = safeObjectPath(options.objectPath || options.name, "object_path");
    const sourceGeneration = positiveGeneration(options.generation, "generation");
    const candidate = await findSoftDeletedFile(bucket, objectPath, sourceGeneration);
    if (!candidate) throw backupError("workspace_recovery_generation_not_found", 404);
    const restoreOptions = {generation: sourceGeneration};
    if (options.restoreToken) restoreOptions.restoreToken = String(options.restoreToken);
    const restored = await restoreFile(candidate, restoreOptions);
    const metadata = await restoredMetadata(restored, candidate);
    const evidence = await verifyObjectEvidence(metadata, options, restored || candidate);
    const result = {
      bucketName: binding.bucketName,
      objectPath,
      sourceGeneration,
      restoredGeneration: positiveGeneration(metadata.generation, "restored_generation"),
      md5Hash: metadata.md5Hash || null,
      crc32c: metadata.crc32c || null,
      size: Number(metadata.size || 0),
      ...evidence,
    };
    await updateReservationRetention(reservation, null);
    return result;
  }

  async function recoverTree(uid, workspaceId, reservationId, manifestInput, options = {}) {
    const reservation = await assertReservation(uid, workspaceId, reservationId);
    const workspace = await loadWorkspace(uid, workspaceId);
    const {bucket, binding} = await validatedBucket(workspace);
    const manifest = normalizeRecoveryManifest(manifestInput, {bucketName: binding.bucketName, workspaceId});
    const treePrefix = safeObjectPath(options.treePrefix || `recovery-trees/${reservation.reservationId}`, "tree_prefix");
    const controlManifestPath = `${treePrefix}/.mapache-internal/recovery-control.json`;
    const copied = [];
    let totalBytes = 0;
    for (const entry of manifest.objects) {
      const candidate = await findSoftDeletedFile(bucket, entry.objectPath, entry.generation);
      if (!candidate) throw backupError("workspace_recovery_source_unavailable", 409, {objectPath: entry.objectPath, generation: entry.generation});
      const restored = await restoreFile(candidate, {
        generation: entry.generation,
        ...(entry.restoreToken ? {restoreToken: entry.restoreToken} : {}),
      });
      const restoredMetadataValue = await restoredMetadata(restored, candidate);
      const source = bucket.file(entry.objectPath);
      const destinationPath = `${treePrefix}/${entry.relativePath}`;
      const destination = bucket.file(destinationPath);
      await copyRestoredObject(source, destination, restoredMetadataValue);
      const destinationMetadata = await readObjectMetadata(destination);
      await verifyObjectEvidence(destinationMetadata, entry, destination);
      const size = Number(destinationMetadata.size || entry.size || 0);
      totalBytes += Number.isFinite(size) ? size : 0;
      copied.push({
        path: entry.relativePath,
        objectPath: destinationPath,
        sourceObjectPath: entry.objectPath,
        sourceGeneration: entry.generation,
        generation: String(destinationMetadata.generation || ""),
        byteLength: size,
        md5Hash: destinationMetadata.md5Hash || entry.md5Hash || null,
        crc32c: destinationMetadata.crc32c || entry.crc32c || null,
        sha256: entry.sha256 || null,
      });
    }

    const storageGeneration = `${reservation.reservationId}-${Date.now()}`;
    const readyMarkerPath = `${treePrefix}/.mapache-internal/workspace-ready.json`;
    const readyMarker = {
      kind: "mapache-workspace-recovery-ready",
      state: "ready",
      storageGeneration,
      operationId: reservation.reservationId,
      workspaceId,
    };
    await saveJson(bucket.file(readyMarkerPath), readyMarker);
    const control = {
      version: RECOVERY_VERSION,
      kind: "mapache-workspace-recovery-tree",
      state: "ready",
      operationId: reservation.reservationId,
      workspaceId,
      bucketName: binding.bucketName,
      storageGeneration,
      treePrefix,
      objects: copied,
      sourceManifest: {version: manifest.version, objectCount: manifest.objects.length},
      readyMarkerObjectPath: readyMarkerPath,
      totalBytes,
      publishedAt: currentDate().toISOString(),
    };
    await saveJson(bucket.file(controlManifestPath), control);
    const pointer = {
      version: RECOVERY_VERSION,
      state: "ready",
      operationId: reservation.reservationId,
      bucketName: binding.bucketName,
      storageGeneration,
      treePrefix,
      controlManifestPath,
      readyMarkerObjectPath: readyMarkerPath,
      objectCount: copied.length,
      totalBytes,
      sourceManifestVersion: manifest.version,
      publishedAt: currentDate().toISOString(),
    };
    await publishRecoveryPointer(uid, workspaceId, reservation.reservationId, pointer);
    return {ok: true, pointer, control};
  }

  async function publishRecoveryPointer(uid, workspaceId, reservationId, pointer) {
    const reservation = await assertReservation(uid, workspaceId, reservationId);
    const workspaceRef = workspaceDocument(workspaceId);
    let published;
    await db.runTransaction(async (transaction) => {
      const workspaceSnap = await transaction.get(workspaceRef);
      if (!workspaceSnap?.exists) throw backupError("workspace_not_found", 404);
      const workspace = workspaceSnap.data() || {};
      assertOwner(workspace, uid);
      assertWorkspaceAvailable(workspace);
      await assertPaused(readSessions(transaction, workspaceRef, workspaceId));
      published = {
        ...pointer,
        publishedAt: pointer.publishedAt || currentDate().toISOString(),
        reservationId: reservation.reservationId,
      };
      transaction.update(workspaceRef, {
        [RECOVERY_POINTER_FIELD]: published,
        sharedStorageRecoveryError: null,
        updatedAt: serverTimestamp(admin),
      });
    });
    return published;
  }

  async function assertReservation(uid, workspaceId, reservationId) {
    const ownerUid = requiredId(uid, "owner_uid");
    const targetWorkspaceId = requiredId(workspaceId, "workspace_id");
    const cleanReservationId = requiredId(reservationId, "reservation_id");
    const snap = await reservationDocument(targetWorkspaceId).get();
    if (!snap?.exists) throw backupError("workspace_recovery_reservation_not_found", 404);
    const reservation = snap.data() || {};
    if (reservation.reservationId !== cleanReservationId || reservation.ownerUid !== ownerUid) {
      throw backupError("workspace_recovery_reservation_mismatch", 409);
    }
    if (reservation.state !== "reserved" || isExpired(reservation.expiresAt, currentDate())) {
      throw backupError("workspace_recovery_reservation_expired", 409);
    }
    await assertPaused(readSessions(null, workspaceDocument(targetWorkspaceId), targetWorkspaceId));
    return reservation;
  }

  async function validatedBucket(workspace) {
    const binding = {
      bucketName: String(workspace.sharedStorage?.bucketName || "").trim(),
      projectId: String(workspace.sharedStorage?.projectId || projectId).trim(),
      workspaceId: workspace.id,
      ownerUid: workspace.ownerUid,
    };
    if (!binding.bucketName) throw backupError("workspace_storage_bucket_missing", 409);
    const bucket = storage.bucket(binding.bucketName);
    const metadata = await readBucketMetadata(bucket);
    try {
      assertSharedBucketContract(metadata, binding);
    } catch (error) {
      throw backupError(publicCode(error, "workspace_bucket_contract_invalid"), 409);
    }
    if (projectId && binding.projectId && binding.projectId !== projectId) {
      throw backupError("workspace_bucket_project_mismatch", 409, {
        expectedProjectId: projectId,
        observedProjectId: binding.projectId,
      });
    }
    const retentionSeconds = Number(metadata.softDeletePolicy?.retentionDurationSeconds);
    if (retentionSeconds !== SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS) {
      throw backupError("workspace_bucket_soft_delete_retention_mismatch", 409, {
        observedSoftDeleteRetentionSeconds: retentionSeconds,
      });
    }
    if (metadata.versioning?.enabled !== false) {
      throw backupError("workspace_bucket_versioning_must_be_disabled", 409, {
        observedVersioningEnabled: metadata.versioning?.enabled === true,
      });
    }
    return {bucket, binding, metadata};
  }

  async function loadWorkspace(uid, workspaceId) {
    const ref = workspaceDocument(workspaceId);
    const snap = await ref.get();
    if (!snap?.exists) throw backupError("workspace_not_found", 404);
    const workspace = {id: snap.id || workspaceId, ...snap.data()};
    assertOwner(workspace, uid);
    assertWorkspaceAvailable(workspace);
    return workspace;
  }

  async function listSoftDeletedFiles(bucket, options = {}) {
    if (typeof bucket.getFiles !== "function") throw backupError("workspace_storage_inventory_unavailable", 503);
    const query = {softDeleted: true, autoPaginate: false};
    if (options.prefix) query.prefix = safeObjectPath(options.prefix, "prefix");
    if (options.pageToken) query.pageToken = String(options.pageToken);
    const response = await bucket.getFiles(query);
    const files = Array.isArray(response?.[0]) ? response[0] : Array.isArray(response) ? response : response?.files || [];
    const nextQuery = Array.isArray(response) ? response[1] || null : response?.nextQuery || null;
    const recoverable = files.map((file) => normalizeObject(file))
        .filter((file) => !isRetentionExpired(file.timeDeleted, currentDate()));
    return Object.assign(recoverable, {nextQuery});
  }

  async function findSoftDeletedFile(bucket, objectPath, generation) {
    const files = await listSoftDeletedFiles(bucket, {prefix: objectPath});
    return files.find((file) => file.name === objectPath && file.generation === generation)?.file || null;
  }

  async function updateReservationRetention(reservation, retention) {
    if (!retention) return;
    await reservationDocument(reservation.workspaceId).update({retention, updatedAt: currentDate().toISOString()});
  }

  async function readObjectMetadata(file) {
    if (typeof file?.getMetadata !== "function") return file?.metadata || file || {};
    const response = await file.getMetadata();
    return Array.isArray(response) ? response[0] || {} : response || {};
  }

  async function restoredMetadata(restored, original) {
    const fromRestore = restored?.metadata || restored || {};
    if (fromRestore.generation) return fromRestore;
    return readObjectMetadata(original);
  }

  async function restoreFile(file, options) {
    if (typeof file?.restore !== "function") throw backupError("workspace_storage_restore_unavailable", 503);
    try {
      const result = await file.restore(options);
      return Array.isArray(result) ? result[0] || file : result || file;
    } catch (error) {
      throw backupError("workspace_storage_restore_failed", 502, {cause: error});
    }
  }

  async function copyRestoredObject(source, destination, sourceMetadata) {
    try {
      if (typeof source.copy === "function") {
        await source.copy(destination, {preconditionOpts: {ifGenerationMatch: 0}});
      } else if (typeof source.download === "function" && typeof destination.save === "function") {
        const downloaded = await source.download();
        const content = Buffer.isBuffer(downloaded) ? downloaded : Buffer.isBuffer(downloaded?.[0]) ? downloaded[0] : Buffer.from(downloaded?.[0] || downloaded || "");
        await destination.save(content, {resumable: false});
      } else {
        throw backupError("workspace_storage_copy_unavailable", 503);
      }
    } catch (error) {
      if (error?.publicMessage) throw error;
      throw backupError("workspace_storage_copy_failed", 502, {cause: error, sourceGeneration: sourceMetadata.generation});
    }
  }

  async function saveJson(file, value) {
    if (typeof file?.save !== "function") throw backupError("workspace_storage_write_unavailable", 503);
    await file.save(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), {
      contentType: "application/json",
      resumable: false,
    });
  }

  async function verifyObjectEvidence(metadata, expected, file) {
    if (expected.md5Hash && metadata.md5Hash !== expected.md5Hash) {
      throw backupError("workspace_storage_content_hash_mismatch", 409, {hash: "md5Hash"});
    }
    if (expected.crc32c && metadata.crc32c !== expected.crc32c) {
      throw backupError("workspace_storage_content_hash_mismatch", 409, {hash: "crc32c"});
    }
    if (expected.size !== undefined && Number(metadata.size) !== Number(expected.size)) {
      throw backupError("workspace_storage_content_size_mismatch", 409);
    }
    if (expected.sha256) {
      if (typeof file?.download !== "function") throw backupError("workspace_storage_content_hash_unavailable", 409, {hash: "sha256"});
      const downloaded = await file.download();
      const content = Buffer.isBuffer(downloaded) ? downloaded : Buffer.isBuffer(downloaded?.[0]) ? downloaded[0] : Buffer.from(downloaded?.[0] || downloaded || "");
      const actual = crypto.createHash("sha256").update(content).digest("hex");
      if (actual !== String(expected.sha256)) throw backupError("workspace_storage_content_hash_mismatch", 409, {hash: "sha256"});
      return {sha256: actual};
    }
    return {};
  }

  function currentDate() {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  }
}

function normalizeRecoveryManifest(value, {bucketName, workspaceId} = {}) {
  if (!value || Number(value.version || value.manifestVersion) !== RECOVERY_VERSION) {
    throw backupError("workspace_recovery_manifest_invalid", 400);
  }
  if (value.workspaceId && String(value.workspaceId) !== String(workspaceId)) {
    throw backupError("workspace_recovery_manifest_workspace_mismatch", 409);
  }
  if (value.bucketName && String(value.bucketName) !== bucketName) {
    throw backupError("workspace_recovery_manifest_bucket_mismatch", 409);
  }
  const sourceObjects = Array.isArray(value.objects) ? value.objects : Array.isArray(value.files) ? value.files : [];
  if (!sourceObjects.length) throw backupError("workspace_recovery_manifest_empty", 400);
  const seen = new Set();
  const objects = sourceObjects.map((entry) => {
    const objectPath = safeObjectPath(entry.objectPath || entry.sourceObjectPath || entry.path, "manifest_object_path");
    const relativePath = safeObjectPath(entry.relativePath || entry.path || objectPath, "manifest_relative_path");
    const generation = positiveGeneration(entry.generation || entry.sourceGeneration, "manifest_generation");
    if (seen.has(relativePath)) throw backupError("workspace_recovery_manifest_duplicate_path", 400);
    seen.add(relativePath);
    return {
      objectPath,
      relativePath,
      generation,
      restoreToken: entry.restoreToken ? String(entry.restoreToken) : "",
      md5Hash: entry.md5Hash || null,
      crc32c: entry.crc32c || null,
      sha256: entry.sha256 || null,
      size: entry.size === undefined && entry.byteLength === undefined ? undefined : Number(entry.size ?? entry.byteLength),
    };
  });
  return {version: RECOVERY_VERSION, objects};
}

function normalizeObject(file) {
  const metadata = file?.metadata || file || {};
  return {
    file,
    name: String(metadata.name || file?.name || ""),
    generation: String(metadata.generation || file?.generation || ""),
    size: Number(metadata.size || 0),
    md5Hash: metadata.md5Hash || null,
    crc32c: metadata.crc32c || null,
    restoreToken: metadata.restoreToken || null,
    timeDeleted: metadata.timeDeleted || null,
  };
}

function publicObject(object) {
  const {file: _file, ...safe} = object;
  return safe;
}

function retentionSummary(files = []) {
  const values = files.map((file) => publicObject(file));
  let retainedBytes = 0;
  let known = true;
  const recoverableUntil = [];
  for (const file of values) {
    const size = Number(file.size);
    if (!Number.isFinite(size) || size < 0) known = false;
    else retainedBytes += size;
    const deleted = file.timeDeleted ? new Date(file.timeDeleted) : null;
    if (deleted && !Number.isNaN(deleted.getTime())) recoverableUntil.push(new Date(deleted.getTime() + SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS * 1000).toISOString());
  }
  return {
    objectCount: values.length,
    retainedBytes: known ? retainedBytes : null,
    retainedBytesKnown: known,
    recoverableUntil: recoverableUntil.sort().at(-1) || null,
    retentionSeconds: SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
  };
}

function emptyRetentionSummary() {
  return {objectCount: 0, retainedBytes: 0, retainedBytesKnown: true, recoverableUntil: null, retentionSeconds: SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS};
}

async function readBucketMetadata(bucket) {
  if (!bucket || typeof bucket.getMetadata !== "function") throw backupError("workspace_storage_bucket_unavailable", 503);
  const response = await bucket.getMetadata();
  return Array.isArray(response) ? response[0] || {} : response || {};
}

function readSessions(transaction, workspaceRef, workspaceId) {
  const sessionsRef = workspaceRef && typeof workspaceRef.collection === "function" ? workspaceRef.collection("sessions") : null;
  if (!sessionsRef) return [];
  const result = transaction && typeof transaction.get === "function" ? transaction.get(sessionsRef) : sessionsRef.get();
  return Promise.resolve(result).then((snapshot) => (snapshot?.docs || []).map((doc) => ({id: doc.id, ...doc.data()})));
}

async function assertPaused(sessions) {
  const values = await Promise.resolve(sessions);
  const active = values.find((session) => ACTIVE_RUNNER_STATUSES.has(String(session.status || "").trim().toLowerCase()));
  if (active) throw backupError("workspace_must_be_paused", 409, {sessionId: active.id});
}

function requiredId(value, label) {
  const clean = String(value || "").trim();
  if (!clean || !/^[A-Za-z0-9._-]{1,200}$/.test(clean)) throw backupError(`invalid_${label}`, 400);
  return clean;
}

function safeObjectPath(value, label) {
  const clean = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!clean || clean.includes("..") || clean.includes("\\") || clean.startsWith("/")) throw backupError(`invalid_${label}`, 400);
  return clean;
}

function positiveGeneration(value, label) {
  const clean = String(value || "").trim();
  if (!/^\d+$/.test(clean) || BigInt(clean) <= 0n) throw backupError(`invalid_${label}`, 400);
  return clean;
}

function assertOwner(workspace, uid) {
  if (workspace.ownerUid !== uid) throw backupError("workspace_forbidden", 403);
}

function assertWorkspaceAvailable(workspace) {
  if (workspace.deleted === true || ["deleting", "deleted"].includes(String(workspace.lifecycle || workspace.status || "").toLowerCase())) {
    throw backupError("workspace_deleted", 409);
  }
}

function isExpired(value, timestamp) {
  const expiry = new Date(typeof value?.toDate === "function" ? value.toDate() : value);
  return Number.isNaN(expiry.getTime()) || expiry.getTime() <= timestamp.getTime();
}

function isRetentionExpired(value, timestamp) {
  if (!value) return false;
  const deleted = new Date(typeof value?.toDate === "function" ? value.toDate() : value);
  return !Number.isNaN(deleted.getTime()) &&
    deleted.getTime() + SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS * 1000 <= timestamp.getTime();
}

function publicReservation(reservation) {
  return {
    reservationId: reservation.reservationId,
    workspaceId: reservation.workspaceId,
    state: reservation.state,
    reservedAt: reservation.reservedAt,
    expiresAt: reservation.expiresAt,
    retention: reservation.retention || null,
  };
}

function publicCode(error, fallback) {
  return String(error?.publicMessage || error?.code || fallback).replace(/[^A-Za-z0-9_-]/g, "_");
}

function serverTimestamp(admin) {
  return admin?.firestore?.FieldValue?.serverTimestamp ? admin.firestore.FieldValue.serverTimestamp() : new Date().toISOString();
}

function writeDocument(transaction, ref, value) {
  if (typeof transaction.set === "function") transaction.set(ref, value, {merge: true});
  else transaction.update(ref, value);
}

module.exports = {
  ACTIVE_RUNNER_STATUSES,
  RECOVERY_POINTER_FIELD,
  RECOVERY_RESERVATION_COLLECTION,
  RECOVERY_VERSION,
  RESERVATION_TTL_MS,
  SHARED_STORAGE_SOFT_DELETE_RETENTION_SECONDS,
  createWorkspaceStorageBackupService,
  emptyRetentionSummary,
  normalizeRecoveryManifest,
  retentionPolicy,
  retentionSummary,
};
