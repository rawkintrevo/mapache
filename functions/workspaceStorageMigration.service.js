"use strict";

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {DEFAULT_BUCKET} = require("./backendConfig");
const {httpError, normalizeStoragePrefix} = require("./backendUtils.helpers");
const {
  isWorkspaceStorageMigrationActive,
} = require("./runtimeReservation.helpers");
const {operationIdForWorkspace} = require("./workspaceSharedStorage.service");

const SHARED_STORAGE_MODE = "shared-gcsfuse-v1";
const ACTIVE_MIGRATION_STATES = new Set(["preparing", "migrating"]);
const ACTIVE_SESSION_STATES = new Set([
  "provisioning", "running", "ready", "restarting", "resizing", "needs_service", "stopping", "deleting",
]);

function createWorkspaceStorageMigrationService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    db: dependencies.db || defaultDb,
    now: dependencies.now || (() => new Date().toISOString()),
    requireWorkspace: dependencies.requireWorkspace,
    sessionCollection: dependencies.sessionCollection,
    sharedStorageService: dependencies.sharedStorageService,
    storage: dependencies.storage,
    verifyReadyGeneration: dependencies.verifyReadyGeneration,
  };
  return {
    complete: (uid, workspaceId, payload) => completeMigration(uid, workspaceId, payload, shared),
    fail: (uid, workspaceId, payload) => failMigration(uid, workspaceId, payload, shared),
    getStatus: (uid, workspaceId) => getMigrationStatus(uid, workspaceId, shared),
    prepare: (uid, workspaceId) => prepareMigration(uid, workspaceId, shared),
  };
}

async function prepareMigration(uid, workspaceId, dependencies = {}) {
  const {workspaceRef, workspace, migration, response} = await reserveMigration(uid, workspaceId, dependencies);
  if (response) {
    if (!response.alreadyReady) return response;
    let descriptor;
    try {
      if (typeof dependencies.sharedStorageService?.validateExistingWorkspaceSharedStorage !== "function") {
        throw migrationError("workspace_storage_migration_unavailable", 503);
      }
      descriptor = await dependencies.sharedStorageService.validateExistingWorkspaceSharedStorage(uid, workspaceId);
    } catch (error) {
      await persistExistingStorageFailure(workspaceRef, uid, error, dependencies);
      throw normalizeMigrationError(error);
    }
    return reconcileExistingReadyStorage(workspaceRef, uid, workspaceId, descriptor, dependencies);
  }

  let identity;
  try {
    if (typeof dependencies.sharedStorageService?.ensureWorkspaceSharedStorage !== "function") {
      throw migrationError("workspace_storage_migration_unavailable", 503);
    }
    identity = await dependencies.sharedStorageService.ensureWorkspaceSharedStorage(uid, workspaceId);
  } catch (error) {
    await persistMigrationFailure(workspaceRef, migration, error, dependencies);
    throw normalizeMigrationError(error);
  }

  const updated = await dependencies.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(workspaceRef);
    if (!snapshot.exists) throw migrationError("workspace_not_found", 404);
    const current = snapshot.data() || {};
    assertOwner(current, uid);
    assertMigrationIdentity(current, migration.operationId);
    const now = serverTimestamp(dependencies.admin);
    const next = {
      ...migration,
      state: "migrating",
      bucketName: identity.bucketName,
      projectId: identity.projectId,
      projectNumber: identity.projectNumber,
      progress: {phase: "awaiting_import", completed: false},
      updatedAt: now,
      errorCode: null,
    };
    transaction.update(workspaceRef, {
      sharedStorageState: "migrating",
      sharedStorageErrorCode: null,
      sharedStorageMigration: next,
      updatedAt: now,
    });
    return next;
  });

  return migrationResponse(workspace, updated, {accepted: true});
}

async function reserveMigration(uid, workspaceId, dependencies) {
  const workspaceRef = workspaceDocument(dependencies.db, workspaceId);
  let response = null;
  let workspace = null;
  let migration = null;
  await dependencies.db.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists) throw migrationError("workspace_not_found", 404);
    workspace = workspaceSnap.data() || {};
    assertOwner(workspace, uid);
    assertWorkspaceAvailable(workspace);
    const sessions = await readSessions(transaction, workspaceRef, dependencies);
    assertPaused(sessions);

    const existing = workspace.sharedStorageMigration || {};
    if (ACTIVE_MIGRATION_STATES.has(String(existing.state || "").toLowerCase())) {
      response = migrationResponse(workspace, existing, {accepted: true, idempotent: true});
      return;
    }
    if (hasExistingSharedStorageDescriptor(workspace)) {
      response = migrationResponse(workspace, existing, {accepted: true, alreadyReady: true});
      return;
    }

    const operationId = String(existing.operationId || workspace.sharedStorage?.operationId || operationIdForWorkspace(workspaceId)).trim();
    // The importer uses its operation ID as the immutable tree generation so
    // resume and cutover share one deterministic destination namespace.
    const generation = String(existing.generation || operationId);
    migration = {
      version: 1,
      operationId,
      generation,
      state: "preparing",
      progress: {phase: "bucket", completed: false},
      source: {
        bucketName: workspace.bucket || DEFAULT_BUCKET,
        prefix: normalizeStoragePrefix(workspace.storagePrefix || ""),
      },
      startedAt: existing.startedAt || serverTimestamp(dependencies.admin),
      updatedAt: serverTimestamp(dependencies.admin),
      errorCode: null,
    };
    transaction.update(workspaceRef, {
      sharedStorageState: "preparing",
      sharedStorageErrorCode: null,
      sharedStorageMigration: migration,
      updatedAt: serverTimestamp(dependencies.admin),
    });
  });
  return {workspaceRef, workspace, migration, response};
}

async function completeMigration(uid, workspaceId, payload = {}, dependencies = {}) {
  const workspaceRef = workspaceDocument(dependencies.db, workspaceId);
  const result = normalizeImportResult(payload);
  await verifyReadyResult(result, dependencies);
  let completed;
  await dependencies.db.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists) throw migrationError("workspace_not_found", 404);
    const workspace = workspaceSnap.data() || {};
    assertOwner(workspace, uid);
    assertWorkspaceAvailable(workspace);
    assertPaused(await readSessions(transaction, workspaceRef, dependencies));
    const migration = workspace.sharedStorageMigration || {};
    if (migration.operationId !== result.operationId) throw migrationError("workspace_storage_migration_conflict", 409);
    if (migration.generation && migration.generation !== result.storageGeneration) {
      throw migrationError("workspace_storage_migration_generation_conflict", 409);
    }
    if (String(migration.state || "").toLowerCase() === "ready") {
      completed = workspace.sharedStorage;
      return;
    }
    if (!ACTIVE_MIGRATION_STATES.has(String(migration.state || "").toLowerCase())) {
      throw migrationError("workspace_storage_migration_not_active", 409);
    }
    const now = serverTimestamp(dependencies.admin);
    completed = {
      ...(workspace.sharedStorage || {}),
      bucketName: result.bucketName,
      projectId: migration.projectId || workspace.sharedStorage?.projectId || null,
      projectNumber: migration.projectNumber || workspace.sharedStorage?.projectNumber || null,
      workspaceId,
      ownerUid: workspace.ownerUid,
      operationId: result.operationId,
      storageGeneration: result.storageGeneration,
      readyMarker: result.readyMarker,
      readyMarkerObjectPath: result.readyMarkerObjectPath,
      treePrefix: result.treePrefix,
      controlManifestPath: result.controlManifestPath,
      state: "ready",
      errorCode: null,
    };
    transaction.update(workspaceRef, {
      sharedStorageState: "ready",
      sharedStorageErrorCode: null,
      sharedStorage: completed,
      workspaceStorageMode: SHARED_STORAGE_MODE,
      sharedStorageMigration: {
        ...migration,
        state: "ready",
        progress: {phase: "complete", completed: true, objectCount: result.objectCount || 0},
        completedAt: now,
        updatedAt: now,
        errorCode: null,
      },
      updatedAt: now,
    });
  });
  return {state: "ready", sharedStorage: safeStorageDescriptor(completed)};
}

async function failMigration(uid, workspaceId, payload = {}, dependencies = {}) {
  const workspaceRef = workspaceDocument(dependencies.db, workspaceId);
  const operationId = String(payload.operationId || "").trim();
  const errorCode = normalizeErrorCode(payload.errorCode || "workspace_storage_migration_failed");
  let result;
  await dependencies.db.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists) throw migrationError("workspace_not_found", 404);
    const workspace = workspaceSnap.data() || {};
    assertOwner(workspace, uid);
    assertWorkspaceAvailable(workspace);
    const migration = workspace.sharedStorageMigration || {};
    if (!operationId || migration.operationId !== operationId) throw migrationError("workspace_storage_migration_conflict", 409);
    const now = serverTimestamp(dependencies.admin);
    const next = {...migration, state: "error", progress: {phase: "error", completed: false}, errorCode, updatedAt: now};
    transaction.update(workspaceRef, {
      sharedStorageState: "error",
      sharedStorageErrorCode: errorCode,
      sharedStorageMigration: next,
      updatedAt: now,
    });
    result = next;
  });
  return {state: "error", operationId, errorCode, progress: result.progress};
}

async function getMigrationStatus(uid, workspaceId, dependencies = {}) {
  const workspace = await loadWorkspace(uid, workspaceId, dependencies);
  return {
    state: String(workspace.sharedStorageMigration?.state || workspace.sharedStorage?.state || workspace.sharedStorageState || "legacy"),
    operationId: workspace.sharedStorageMigration?.operationId || null,
    progress: workspace.sharedStorageMigration?.progress || null,
    errorCode: workspace.sharedStorageMigration?.errorCode || workspace.sharedStorageErrorCode || null,
    storage: safeStorageDescriptor(workspace.sharedStorage),
  };
}

async function verifyReadyResult(result, dependencies) {
  if (typeof dependencies.verifyReadyGeneration === "function") {
    await dependencies.verifyReadyGeneration(result);
    return;
  }
  const storage = dependencies.storage;
  if (!storage) throw migrationError("workspace_storage_migration_verification_unavailable", 503);
  const markerPath = result.readyMarkerObjectPath;
  if (!safeObjectPath(markerPath)) throw migrationError("workspace_storage_migration_marker_invalid", 400);
  try {
    const [content] = await storage.bucket(result.bucketName).file(markerPath).download();
    const marker = JSON.parse(content.toString("utf8"));
    if (marker.state !== "ready" || marker.storageGeneration !== result.storageGeneration || marker.operationId !== result.operationId) {
      throw migrationError("workspace_storage_migration_marker_mismatch", 409);
    }
  } catch (error) {
    if (error.publicMessage) throw error;
    throw migrationError("workspace_storage_migration_marker_unavailable", 502, error);
  }
}

async function readSessions(transaction, workspaceRef, dependencies) {
  const sessionsRef = typeof dependencies.sessionCollection === "function" ?
    dependencies.sessionCollection(workspaceRef.id) : workspaceRef.collection("sessions");
  const snap = await transaction.get(sessionsRef);
  return (snap.docs || []).map((doc) => ({id: doc.id, ...doc.data()}));
}

async function loadWorkspace(uid, workspaceId, dependencies) {
  if (typeof dependencies.requireWorkspace === "function") return dependencies.requireWorkspace(uid, workspaceId);
  const snap = await workspaceDocument(dependencies.db, workspaceId).get();
  if (!snap.exists) throw migrationError("workspace_not_found", 404);
  const workspace = snap.data() || {};
  assertOwner(workspace, uid);
  return workspace;
}

function assertPaused(sessions) {
  const active = sessions.find((session) => ACTIVE_SESSION_STATES.has(String(session.status || "").trim().toLowerCase()));
  if (active) throw migrationError("workspace_must_be_paused", 409, {sessionId: active.id});
}

function assertOwner(workspace, uid) {
  if (workspace.ownerUid !== uid) throw migrationError("workspace_forbidden", 403);
}

function assertWorkspaceAvailable(workspace) {
  if (workspace.deleted === true || ["deleting", "deleted"].includes(
      String(workspace.lifecycle || workspace.status || "").trim().toLowerCase(),
  )) throw migrationError("workspace_deleted", 409);
}

function assertMigrationIdentity(workspace, operationId) {
  if (workspace.sharedStorageMigration?.operationId !== operationId || !isWorkspaceStorageMigrationActive(workspace)) {
    throw migrationError("workspace_storage_migration_conflict", 409);
  }
}

function normalizeImportResult(payload) {
  const operationId = String(payload.operationId || "").trim();
  const bucketName = String(payload.bucketName || "").trim();
  const storageGeneration = String(payload.storageGeneration || payload.generation || "").trim();
  const readyMarker = String(payload.readyMarker || ".mapache-internal/workspace-ready.json").trim();
  const readyMarkerObjectPath = String(payload.readyMarkerObjectPath || "").trim();
  if (!operationId || !bucketName || !storageGeneration || !readyMarkerObjectPath || !safeObjectPath(readyMarkerObjectPath)) {
    throw migrationError("workspace_storage_migration_result_invalid", 400);
  }
  return {
    operationId,
    bucketName,
    storageGeneration,
    readyMarker,
    readyMarkerObjectPath,
    treePrefix: safeObjectPath(payload.treePrefix) ? String(payload.treePrefix) : null,
    controlManifestPath: safeObjectPath(payload.controlManifestPath) ? String(payload.controlManifestPath) : null,
    objectCount: Number.isSafeInteger(Number(payload.objectCount)) ? Number(payload.objectCount) : 0,
  };
}

function migrationResponse(workspace, migration, flags = {}) {
  return {
    accepted: flags.accepted !== false,
    idempotent: Boolean(flags.idempotent),
    alreadyReady: Boolean(flags.alreadyReady),
    state: migration?.state || workspace.sharedStorage?.state || workspace.sharedStorageState || "legacy",
    operationId: migration?.operationId || workspace.sharedStorage?.operationId || null,
    generation: migration?.generation || workspace.sharedStorage?.storageGeneration || null,
    progress: migration?.progress || null,
    errorCode: migration?.errorCode || workspace.sharedStorageErrorCode || null,
    importDescriptor: migration?.operationId ? {
      operationId: migration.operationId,
      sourceBucketName: migration.source?.bucketName || null,
      sourcePrefix: migration.source?.prefix || null,
      targetBucketName: migration.bucketName || null,
      targetGeneration: migration.generation || null,
      targetTreePrefix: migration.generation ? `trees/${migration.generation}` : null,
      readyMarker: ".mapache-internal/workspace-ready.json",
    } : null,
  };
}

function safeStorageDescriptor(value) {
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(["bucketName", "storageGeneration", "readyMarker", "readyMarkerObjectPath", "treePrefix", "state", "operationId"]
      .filter((key) => value[key] !== undefined && value[key] !== null)
      .map((key) => [key, value[key]]));
}

function safeObjectPath(value) {
  const path = String(value || "");
  return Boolean(path && !path.startsWith("/") && !path.includes("..") && !path.includes("\\") && path.length <= 512);
}

function persistMigrationFailure(workspaceRef, migration, error, dependencies) {
  const errorCode = normalizeErrorCode(error?.publicMessage || error?.code || "workspace_storage_migration_failed");
  return dependencies.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(workspaceRef);
    if (!snapshot.exists) return;
    const current = snapshot.data() || {};
    if (current.sharedStorageMigration?.operationId !== migration.operationId) return;
    const now = serverTimestamp(dependencies.admin);
    transaction.update(workspaceRef, {
      sharedStorageState: "error",
      sharedStorageErrorCode: errorCode,
      sharedStorageMigration: {...migration, state: "error", errorCode, updatedAt: now},
      updatedAt: now,
    });
  });
}

async function reconcileExistingReadyStorage(workspaceRef, uid, workspaceId, descriptor, dependencies) {
  let completed;
  await dependencies.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(workspaceRef);
    if (!snapshot.exists) throw migrationError("workspace_not_found", 404);
    const workspace = snapshot.data() || {};
    assertOwner(workspace, uid);
    assertWorkspaceAvailable(workspace);
    assertPaused(await readSessions(transaction, workspaceRef, dependencies));
    const current = workspace.sharedStorage || {};
    if (current.bucketName && current.bucketName !== descriptor.bucketName) {
      throw migrationError("workspace_storage_migration_conflict", 409);
    }
    if (current.storageGeneration && current.storageGeneration !== descriptor.storageGeneration) {
      throw migrationError("workspace_storage_migration_generation_conflict", 409);
    }
    const now = serverTimestamp(dependencies.admin);
    completed = {
      ...current,
      ...descriptor,
      state: "ready",
      errorCode: null,
    };
    transaction.update(workspaceRef, {
      sharedStorageState: "ready",
      sharedStorageErrorCode: null,
      sharedStorage: completed,
      workspaceStorageMode: SHARED_STORAGE_MODE,
      updatedAt: now,
    });
  });
  return {
    accepted: true,
    idempotent: true,
    alreadyReady: true,
    reused: true,
    state: "ready",
    operationId: completed.operationId || null,
    generation: completed.storageGeneration,
    progress: {phase: "reconciled", completed: true},
    errorCode: null,
    importDescriptor: null,
  };
}

function persistExistingStorageFailure(workspaceRef, uid, error, dependencies) {
  const errorCode = normalizeErrorCode(error?.publicMessage || error?.code || "workspace_storage_migration_failed");
  return dependencies.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(workspaceRef);
    if (!snapshot.exists) return;
    const workspace = snapshot.data() || {};
    if (workspace.ownerUid !== uid) return;
    const current = workspace.sharedStorage;
    transaction.update(workspaceRef, {
      sharedStorageState: "error",
      sharedStorageErrorCode: errorCode,
      ...(current ? {sharedStorage: {...current, state: "error", errorCode}} : {}),
      updatedAt: serverTimestamp(dependencies.admin),
    });
  });
}

function hasExistingSharedStorageDescriptor(workspace = {}) {
  return Boolean(workspace.sharedStorage?.bucketName);
}

function normalizeMigrationError(error) {
  if (error?.publicMessage) return error;
  return migrationError("workspace_storage_migration_failed", 502, error);
}

function normalizeErrorCode(value) {
  const code = String(value || "workspace_storage_migration_failed").replace(/[^A-Za-z0-9_-]/g, "_");
  return code.slice(0, 120) || "workspace_storage_migration_failed";
}

function workspaceDocument(db, workspaceId) {
  return db.collection("workspaces").doc(workspaceId);
}

function serverTimestamp(admin) {
  return admin?.firestore?.FieldValue?.serverTimestamp ? admin.firestore.FieldValue.serverTimestamp() : new Date().toISOString();
}

function migrationError(code, status = 500, details = {}) {
  const error = httpError(status, code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

module.exports = {
  ACTIVE_MIGRATION_STATES,
  SHARED_STORAGE_MODE,
  assertPaused,
  createWorkspaceStorageMigrationService,
  isWorkspaceStorageMigrationActive,
  normalizeImportResult,
  prepareMigration,
};
