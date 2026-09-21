"use strict";

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");
const {
  isActiveAutomationStatus,
  isTerminalAutomationStatus,
} = require("./automationState.helpers");
const {isAutomationRuntime} = require("./runtimePaths.helpers");

const DELETION_OPERATION_COLLECTION = "workspaceDeletionOperations";
const DELETION_OPERATION_VERSION = 1;
const SOFT_DELETE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

function createWorkspaceAutomationDeletionService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    automationCleanupService: dependencies.automationCleanupService,
    db: dependencies.db || defaultDb,
    deleteLegacyStorage: dependencies.deleteLegacyStorage,
    deleteSessionForWorkspace: dependencies.deleteSessionForWorkspace,
    deleteSessionService: dependencies.deleteSessionService,
    deleteWorkspaceSharedStorage: dependencies.deleteWorkspaceSharedStorage,
    now: dependencies.now || (() => new Date()),
    sessionCollection: dependencies.sessionCollection,
  };
  if (typeof shared.sessionCollection !== "function") {
    throw new Error("Workspace deletion requires a sessionCollection dependency.");
  }
  if (typeof shared.deleteWorkspaceSharedStorage !== "function") {
    throw new Error("Workspace deletion requires a shared storage deletion dependency.");
  }
  if (typeof shared.deleteSessionService !== "function" &&
      typeof shared.deleteSessionForWorkspace !== "function") {
    throw new Error("Workspace deletion requires a session deletion dependency.");
  }
  return {
    deleteWorkspace: (uid, workspaceId) => deleteWorkspace(uid, workspaceId, shared),
    getOperation: (uid, workspaceId) => getOperation(uid, workspaceId, shared),
    resumeWorkspaceDeletion: (uid, workspaceId) => resumeWorkspaceDeletion(uid, workspaceId, shared),
  };
}

async function deleteWorkspace(uid, workspaceId, dependencies = {}) {
  const normalizedWorkspaceId = normalizeId(workspaceId, "workspace_id");
  await markWorkspaceDeleting(uid, normalizedWorkspaceId, dependencies);
  try {
    return await resumeWorkspaceDeletion(uid, normalizedWorkspaceId, dependencies);
  } catch (error) {
    await recordFailure(normalizedWorkspaceId, error, dependencies);
    throw error;
  }
}

async function getOperation(uid, workspaceId, dependencies = {}) {
  const normalizedWorkspaceId = normalizeId(workspaceId, "workspace_id");
  const workspace = await readOwnedWorkspace(uid, normalizedWorkspaceId, dependencies);
  const snapshot = await operationRef(dependencies.db, normalizedWorkspaceId).get();
  if (!snapshot.exists) return {workspaceId: workspace.id, state: "none"};
  return publicOperation(snapshot);
}

async function resumeWorkspaceDeletion(uid, workspaceId, dependencies = {}) {
  const workspace = await readOwnedWorkspace(uid, workspaceId, dependencies);
  const opRef = operationRef(dependencies.db, workspaceId);
  const opSnap = await opRef.get();
  if (!opSnap.exists) {
    await markWorkspaceDeleting(uid, workspaceId, dependencies);
    return resumeWorkspaceDeletion(uid, workspaceId, dependencies);
  }
  const operation = opSnap.data() || {};
  if (operation.state === "complete") return publicOperation(opSnap);

  await updateOperation(opRef, {
    state: "running",
    phase: "compute",
    errorCode: null,
    updatedAt: serverTimestamp(dependencies),
  }, dependencies);

  const inventory = await captureInventory(workspace, dependencies);
  await updateOperation(opRef, {
    resources: inventory,
    progress: {phase: "compute", completed: false},
    updatedAt: serverTimestamp(dependencies),
  }, dependencies);

  const runResult = await stopAutomationRuns(workspace, dependencies);
  if (runResult.failed.length) {
    throw deletionError("workspace_compute_cleanup_failed", {failed: runResult.failed});
  }

  const sessionResult = await stopRemainingSessions(workspace, new Set(runResult.cleaned), dependencies);
  if (sessionResult.failed.length) {
    throw deletionError("workspace_compute_cleanup_failed", {failed: sessionResult.failed});
  }

  await updateOperation(opRef, {
    phase: "storage",
    progress: {phase: "storage", completed: false},
    compute: {
      runsCanceled: runResult.canceled,
      runsCleaned: runResult.cleaned,
      sessionsDeleted: sessionResult.deleted,
    },
    updatedAt: serverTimestamp(dependencies),
  }, dependencies);

  if (typeof dependencies.deleteLegacyStorage === "function") {
    await dependencies.deleteLegacyStorage(workspace.ownerUid, workspace, {reason: "workspace_deleted"});
  }
  const storageResult = await dependencies.deleteWorkspaceSharedStorage(
      workspace.ownerUid,
      workspaceId,
      {reason: "workspace_deleted", allowDeleting: true},
  );

  await updateOperation(opRef, {
    phase: "records",
    progress: {phase: "records", completed: false},
    storage: storageEvidence(storageResult),
    updatedAt: serverTimestamp(dependencies),
  }, dependencies);

  await deleteWorkspaceRecords(workspaceId, dependencies);
  const now = serverTimestamp(dependencies);
  const completedAt = now;
  const recovery = storageEvidence(storageResult).retainedRecovery || null;
  await dependencies.db.collection("workspaces").doc(workspaceId).update({
    lifecycle: "deleted",
    deleted: true,
    deletionState: "complete",
    deletionCompletedAt: completedAt,
    deletionOperationId: operationIdFor(workspaceId),
    sharedStorageState: "deleted",
    updatedAt: completedAt,
  });
  await opRef.update({
    state: "complete",
    phase: "complete",
    progress: {phase: "complete", completed: true},
    completedAt,
    updatedAt: completedAt,
    cleanupEvidence: {
      computeConfirmedAbsent: true,
      liveObjectsDeleted: storageResult?.deleted !== false,
      bucketDeleted: storageResult?.bucketDeleted === true || storageResult?.deleted === true,
      storage: storageEvidence(storageResult),
    },
    recoverableUntil: recovery?.recoverableUntil || null,
    recoverableBytes: recovery?.retainedBytes ?? null,
  });
  return publicOperation(await opRef.get());
}

async function markWorkspaceDeleting(uid, workspaceId, dependencies = {}) {
  const workspaceRef = dependencies.db.collection("workspaces").doc(workspaceId);
  const opRef = operationRef(dependencies.db, workspaceId);
  await dependencies.db.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
    const workspace = workspaceSnap.data() || {};
    if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
    const operationSnap = await transaction.get(opRef);
    if (operationSnap.exists && operationSnap.data()?.state === "complete") return;
    const now = serverTimestamp(dependencies);
    const existing = operationSnap.exists ? operationSnap.data() || {} : {};
    const operation = {
      version: DELETION_OPERATION_VERSION,
      operationId: operationIdFor(workspaceId),
      workspaceId,
      ownerUid: uid,
      state: existing.state || "running",
      phase: existing.phase || "compute",
      startedAt: existing.startedAt || now,
      updatedAt: now,
      progress: existing.progress || {phase: "compute", completed: false},
      ...(existing.resources ? {resources: existing.resources} : {}),
    };
    if (typeof transaction.set === "function") transaction.set(opRef, operation, {merge: true});
    else transaction.update(opRef, operation);
    transaction.update(workspaceRef, {
      lifecycle: "deleting",
      deleted: true,
      deletionState: "running",
      deletionStartedAt: workspace.deletionStartedAt || now,
      deletionOperationId: operation.operationId,
      updatedAt: now,
    });
  });
}

async function captureInventory(workspace, dependencies = {}) {
  const workspaceId = workspace.id;
  const sessions = await listSessionDocs(workspaceId, dependencies);
  const runs = await listRunDocs(workspaceId, dependencies);
  return {
    workspaceId,
    sessionIds: sessions.map((session) => session.id).sort(),
    automationRunIds: runs.map((run) => run.id).sort(),
    bucketName: workspace.sharedStorage?.bucketName || null,
    storageGeneration: workspace.sharedStorage?.storageGeneration || null,
    storageOperationId: workspace.sharedStorage?.operationId || workspace.sharedStorageMigration?.operationId || null,
  };
}

async function stopAutomationRuns(workspace, dependencies = {}) {
  const runs = await listRunDocs(workspace.id, dependencies);
  const result = {canceled: [], cleaned: [], failed: []};
  for (const run of runs) {
    const action = await markRunForDeletion(run, workspace, dependencies);
    if (action === "canceled") result.canceled.push(run.id);
    if (action === "cleanup") {
      if (typeof dependencies.automationCleanupService?.cleanupAutomationRun !== "function") {
        result.failed.push({runId: run.id, errorCode: "automation_cleanup_unavailable"});
        continue;
      }
      const cleanup = await dependencies.automationCleanupService.cleanupAutomationRun(run.id);
      if (cleanup?.cleaned === false || cleanup?.error) {
        result.failed.push({runId: run.id, errorCode: cleanup.error || "automation_cleanup_failed"});
      } else {
        result.cleaned.push(run.id);
      }
    }
  }
  return result;
}

async function markRunForDeletion(run, workspace, dependencies = {}) {
  const runRef = dependencies.db.collection("automationRuns").doc(run.id);
  let action = "none";
  await dependencies.db.runTransaction(async (transaction) => {
    const runSnap = await transaction.get(runRef);
    if (!runSnap.exists) return;
    const current = runSnap.data() || {};
    if (current.workspaceId !== workspace.id || current.ownerUid !== workspace.ownerUid) return;
    const status = normalize(current.status);
    if (status === "queued") {
      const definitionRef = dependencies.db.collection("workspaces").doc(workspace.id)
          .collection("automations").doc(String(current.automationId || ""));
      const definitionSnap = await transaction.get(definitionRef);
      const now = serverTimestamp(dependencies);
      transaction.update(runRef, {
        status: "canceled",
        desiredOutcome: "canceled",
        cancellationReason: "workspace_deleted",
        cleanupState: "complete",
        endedAt: now,
        updatedAt: now,
      });
      if (definitionSnap.exists && definitionSnap.data()?.pendingRunId === run.id) {
        transaction.update(definitionRef, {pendingRunId: null, updatedAt: now});
      }
      action = "canceled";
      return;
    }
    if (isActiveAutomationStatus(status)) {
      const now = serverTimestamp(dependencies);
      transaction.update(runRef, {
        status: "stopping",
        desiredOutcome: "canceled",
        cancellationReason: current.cancellationReason || "workspace_deleted",
        cancellationRequestedAt: current.cancellationRequestedAt || now,
        cleanupState: "pending",
        updatedAt: now,
      });
      action = "cleanup";
      return;
    }
    if (isTerminalAutomationStatus(status) && normalize(current.cleanupState) !== "complete") action = "cleanup";
  });
  return action;
}

async function stopRemainingSessions(workspace, cleanedAutomationRunIds = new Set(), dependencies = {}) {
  const sessions = await listSessionDocs(workspace.id, dependencies);
  const result = {deleted: [], failed: []};
  for (const session of sessions) {
    const sessionRef = dependencies.sessionCollection(workspace.id).doc(session.id);
    try {
      if (isAutomationRuntime(session)) {
        const runId = String(session.automationRunId || session.runId || "").trim();
        if (runId && cleanedAutomationRunIds.has(runId)) {
          await sessionRef.delete();
          result.deleted.push(session.id);
          continue;
        }
        const deletion = await dependencies.deleteSessionService(sessionRef, session, {
          reason: "workspace_deleted",
          returnDetails: true,
        });
        const details = deletion && typeof deletion === "object" ? deletion : {serviceAbsent: deletion === true};
        if (details.serviceAbsent !== true) throw deletionError("automation_service_delete_failed");
        await sessionRef.delete();
      } else if (typeof dependencies.deleteSessionForWorkspace === "function") {
        await dependencies.deleteSessionForWorkspace(sessionRef, session, {reason: "workspace_deleted"});
      } else {
        const deletion = await dependencies.deleteSessionService(sessionRef, session, {
          reason: "workspace_deleted",
          returnDetails: true,
        });
        const details = deletion && typeof deletion === "object" ? deletion : {serviceAbsent: deletion === true};
        if (details.serviceAbsent !== true) throw deletionError("session_delete_failed");
        await sessionRef.delete();
      }
      result.deleted.push(session.id);
    } catch (error) {
      result.failed.push({sessionId: session.id, errorCode: stableErrorCode(error)});
    }
  }
  return result;
}

async function deleteWorkspaceRecords(workspaceId, dependencies = {}) {
  const runDocs = await listRunDocs(workspaceId, dependencies);
  for (const run of runDocs) await deleteRefTree(run.ref, dependencies);
  for (const collectionName of ["sessions", "automations", "automationAudit"]) {
    const collection = dependencies.db.collection("workspaces").doc(workspaceId).collection(collectionName);
    await deleteCollectionTree(collection, dependencies, collectionName === "sessions" ? ["terminalHistory"] :
      collectionName === "automations" ? ["audit"] : []);
  }
}

async function listSessionDocs(workspaceId, dependencies = {}) {
  const snap = await dependencies.sessionCollection(workspaceId).get();
  return (snap.docs || []).map((doc) => ({id: doc.id, ref: doc.ref, ...(doc.data() || {})}));
}

async function listRunDocs(workspaceId, dependencies = {}) {
  let query = dependencies.db.collection("automationRuns");
  if (typeof query.where === "function") query = query.where("workspaceId", "==", workspaceId);
  const snap = await query.get();
  return (snap.docs || [])
      .map((doc) => ({id: doc.id, ref: doc.ref, ...(doc.data() || {})}))
      .filter((run) => run.workspaceId === workspaceId);
}

async function deleteCollectionTree(collection, dependencies = {}, childCollections = []) {
  if (typeof dependencies.db.recursiveDelete === "function") {
    await dependencies.db.recursiveDelete(collection);
    return;
  }
  const snap = await collection.get();
  for (const doc of snap.docs || []) await deleteRefTree(doc.ref, dependencies, childCollections);
}

async function deleteRefTree(ref, dependencies = {}, childCollections = []) {
  if (!ref) return;
  if (typeof dependencies.db.recursiveDelete === "function") {
    await dependencies.db.recursiveDelete(ref);
    return;
  }
  for (const collectionName of childCollections) {
    if (typeof ref.collection === "function") {
      await deleteCollectionTree(ref.collection(collectionName), dependencies);
    }
  }
  if (typeof ref.delete === "function") await ref.delete();
}

async function readOwnedWorkspace(uid, workspaceId, dependencies = {}) {
  const snap = await dependencies.db.collection("workspaces").doc(workspaceId).get();
  if (!snap.exists) throw httpError(404, "workspace_not_found");
  const workspace = {id: snap.id, ...(snap.data() || {})};
  if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
  return workspace;
}

async function updateOperation(ref, updates, dependencies = {}) {
  await ref.update(updates);
}

async function recordFailure(workspaceId, error, dependencies = {}) {
  try {
    await operationRef(dependencies.db, workspaceId).update({
      state: "blocked",
      phase: "blocked",
      errorCode: stableErrorCode(error),
      lastErrorAt: serverTimestamp(dependencies),
      updatedAt: serverTimestamp(dependencies),
    });
  } catch (_recordError) {
    // Preserve the original deletion failure. Reconciliation can recreate the
    // operation record from the workspace tombstone on the next retry.
  }
}

function storageEvidence(result) {
  if (!result || typeof result !== "object") return {deleted: result === true};
  return {
    deleted: result.deleted === true,
    bucketDeleted: result.bucketDeleted === true || result.deleted === true,
    bucketName: result.bucketName || null,
    retainedRecovery: result.retainedRecovery || null,
  };
}

function publicOperation(snapshot) {
  const data = snapshot.data() || {};
  return {
    operationId: data.operationId || snapshot.id,
    workspaceId: data.workspaceId || null,
    state: data.state || "running",
    phase: data.phase || null,
    progress: data.progress || null,
    errorCode: data.errorCode || null,
    recoverableUntil: data.recoverableUntil || data.storage?.retainedRecovery?.recoverableUntil || null,
    recoverableBytes: data.recoverableBytes ?? data.storage?.retainedRecovery?.retainedBytes ?? null,
    cleanupEvidence: data.cleanupEvidence || null,
    startedAt: data.startedAt || null,
    completedAt: data.completedAt || null,
    updatedAt: data.updatedAt || null,
  };
}

function operationRef(db, workspaceId) {
  return db.collection(DELETION_OPERATION_COLLECTION).doc(workspaceId);
}

function operationIdFor(workspaceId) {
  return `workspace-delete-${workspaceId}`;
}

function serverTimestamp(dependencies) {
  return dependencies.admin?.firestore?.FieldValue?.serverTimestamp?.() || dependencies.now();
}

function deletionError(code, details = {}) {
  const error = httpError(502, code);
  Object.assign(error, details);
  return error;
}

function stableErrorCode(error) {
  const code = normalize(error?.publicMessage || error?.code || "workspace_deletion_failed");
  return /^[a-z0-9_:-]{1,120}$/.test(code) ? code : "workspace_deletion_failed";
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeId(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw httpError(400, `invalid_${label}`);
  return normalized;
}

module.exports = {
  DELETION_OPERATION_COLLECTION,
  DELETION_OPERATION_VERSION,
  SOFT_DELETE_RETENTION_SECONDS,
  createWorkspaceAutomationDeletionService,
  operationIdFor,
  resumeWorkspaceDeletion,
};
