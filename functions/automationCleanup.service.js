"use strict";

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {httpError, serialize} = require("./backendUtils.helpers");
const {
  isActiveAutomationStatus,
  isTerminalAutomationStatus,
} = require("./automationState.helpers");
const {automationSessionId} = require("./runtimePaths.helpers");
const {validateAutomationId} = require("./automationValidation.helpers");

const TERMINAL_OUTCOMES = new Set(["succeeded", "failed", "canceled", "interrupted"]);

function createAutomationCleanupService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    db: dependencies.db || defaultDb,
    deleteSessionService: dependencies.deleteSessionService,
    releaseAutomationSlot: dependencies.releaseAutomationSlot || dependencies.releaseAfterCleanup,
    sessionCollection: dependencies.sessionCollection,
    wakeQueue: dependencies.wakeQueue,
  };
  if (typeof shared.deleteSessionService !== "function") {
    throw new Error("Automation cleanup requires a deleteSessionService dependency.");
  }
  if (typeof shared.releaseAutomationSlot !== "function") {
    throw new Error("Automation cleanup requires a releaseAutomationSlot dependency.");
  }
  if (typeof shared.sessionCollection !== "function") {
    throw new Error("Automation cleanup requires a sessionCollection dependency.");
  }
  return {
    cleanupAutomationRun: (runId) => cleanupAutomationRun(runId, shared),
    handleAutomationRunEvent: (event) => handleAutomationRunEvent(event, shared),
    stopRun: (actor, runId) => stopRun(actor, runId, shared),
  };
}

async function handleAutomationRunEvent(event, dependencies = {}) {
  const after = event && event.data && event.data.after;
  if (!after || !after.exists) return {skipped: "deleted"};
  const run = after.data() || {};
  if (run.status === "stopping" ||
      (isTerminalAutomationStatus(run.status) && normalize(run.cleanupState) !== "complete")) {
    return cleanupAutomationRun(after.id || event.params?.runId, dependencies);
  }
  return {skipped: "not_cleanup_candidate", runId: after.id || event.params?.runId};
}

async function stopRun(actor, runId, dependencies = {}) {
  const actorUid = requireActorUid(actor);
  const normalizedRunId = validateRunId(runId);
  const firestore = dependencies.db || defaultDb;
  const admin = dependencies.admin || defaultAdmin;
  const runRef = firestore.collection("automationRuns").doc(normalizedRunId);
  let action = "noop";
  let workspaceId = "";
  let response;

  await firestore.runTransaction(async (transaction) => {
    const runSnap = await transaction.get(runRef);
    if (!runSnap.exists) throw httpError(404, "automation_run_not_found");
    const run = runSnap.data() || {};
    workspaceId = String(run.workspaceId || "").trim();
    if (run.ownerUid !== actorUid) throw httpError(403, "automation_run_forbidden");
    const workspaceRef = firestore.collection("workspaces").doc(workspaceId);
    const workspaceSnap = await transaction.get(workspaceRef);
    assertWorkspace(workspaceSnap, actorUid);

    const status = normalize(run.status);
    if (isTerminalAutomationStatus(status)) {
      response = toRunDto(runSnap);
      action = "terminal";
      return;
    }
    const now = serverTimestamp(admin);
    if (status === "queued") {
      const definitionRef = workspaceRef.collection("automations").doc(String(run.automationId || ""));
      const definitionSnap = await transaction.get(definitionRef);
      const updates = {
        status: "canceled",
        cleanupState: "complete",
        cancellationReason: "user_canceled",
        desiredOutcome: "canceled",
        endedAt: now,
        updatedAt: now,
      };
      transaction.update(runRef, updates);
      if (definitionSnap.exists && definitionSnap.data()?.pendingRunId === normalizedRunId) {
        transaction.update(definitionRef, {pendingRunId: null, updatedAt: now});
      }
      response = toRunDto({id: normalizedRunId, data: () => ({...run, ...updates})});
      action = "queued";
      return;
    }
    if (!isActiveAutomationStatus(status)) throw httpError(409, "automation_run_not_stoppable");
    const updates = {
      status: "stopping",
      desiredOutcome: "canceled",
      cancellationReason: run.cancellationReason || "user_canceled",
      cancellationRequestedAt: run.cancellationRequestedAt || now,
      cleanupState: "pending",
      updatedAt: now,
    };
    transaction.update(runRef, updates);
    response = toRunDto({id: normalizedRunId, data: () => ({...run, ...updates})});
    action = "cleanup";
  });

  if (action === "queued" && typeof dependencies.wakeQueue === "function") {
    await dependencies.wakeQueue(workspaceId);
  }
  if (action === "cleanup") {
    await cleanupAutomationRun(normalizedRunId, dependencies);
    const latest = await runRef.get();
    if (latest.exists) response = toRunDto(latest);
  } else if (action === "terminal" && response?.cleanupState !== "complete") {
    await cleanupAutomationRun(normalizedRunId, dependencies);
    const latest = await runRef.get();
    if (latest.exists) response = toRunDto(latest);
  }
  return response;
}

async function cleanupAutomationRun(runId, dependencies = {}) {
  const normalizedRunId = validateRunId(runId);
  const firestore = dependencies.db || defaultDb;
  const runRef = firestore.collection("automationRuns").doc(normalizedRunId);
  const runSnap = await runRef.get();
  if (!runSnap.exists) return {skipped: "run_not_found", runId: normalizedRunId};
  const run = {runId: normalizedRunId, ...runSnap.data()};
  if (normalize(run.cleanupState) === "complete") return {skipped: "already_complete", runId: normalizedRunId};
  if (!isTerminalAutomationStatus(run.status) && normalize(run.status) !== "stopping") {
    return {skipped: "run_not_stopping", runId: normalizedRunId};
  }

  const sessionId = String(run.sessionId || automationSessionId(normalizedRunId)).trim();
  const sessionRef = dependencies.sessionCollection(run.workspaceId).doc(sessionId);
  const sessionSnap = await sessionRef.get();
  const sessionExists = Boolean(sessionSnap.exists);
  const session = sessionExists ? {id: sessionSnap.id, ...sessionSnap.data()} : {
    id: sessionId,
    automationRunId: normalizedRunId,
    runId: normalizedRunId,
    runtimeKind: "automation",
    workspaceId: run.workspaceId,
    ownerUid: run.ownerUid,
  };
  let deletion;
  try {
    deletion = await dependencies.deleteSessionService(sessionRef, session, {
      reason: "automation_cleanup",
      returnDetails: true,
      skipSessionState: !sessionExists,
    });
  } catch (error) {
    return markCleanupError(runRef, normalizedRunId, error, dependencies);
  }
  const details = deletion && typeof deletion === "object" ? deletion : {serviceAbsent: deletion === true};
  if (details.serviceAbsent !== true) {
    return markCleanupError(runRef, normalizedRunId, {code: "automation_service_delete_failed"}, dependencies);
  }

  const finalized = await finalizeRun(runRef, normalizedRunId, {
    persistenceWarning: details.persistenceWarning === true ||
      session.agentRuntimeRecoveryWarning === "interrupted",
  }, dependencies);
  if (!finalized) return {runId: normalizedRunId, skipped: "run_missing"};

  try {
    const released = await dependencies.releaseAutomationSlot(normalizedRunId, {serviceAbsent: true});
    if (!released?.released && released?.workspaceId) {
      throw cleanupError("automation_slot_release_failed");
    }
    return {runId: normalizedRunId, cleaned: true, released: released?.released !== false};
  } catch (error) {
    await markCleanupError(runRef, normalizedRunId, {code: "automation_slot_release_failed"}, dependencies);
    return {runId: normalizedRunId, cleaned: false, error: "automation_slot_release_failed"};
  }
}

async function finalizeRun(runRef, runId, {persistenceWarning = false} = {}, dependencies = {}) {
  const admin = dependencies.admin || defaultAdmin;
  let finalized = false;
  await dependencies.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(runRef);
    if (!snap.exists) return;
    const run = snap.data() || {};
    if (normalize(run.cleanupState) === "complete") {
      finalized = true;
      return;
    }
    const currentStatus = normalize(run.status);
    const desired = normalize(run.desiredOutcome);
    const status = isTerminalAutomationStatus(currentStatus) ? currentStatus :
      TERMINAL_OUTCOMES.has(desired) ? desired : "interrupted";
    const timestamp = serverTimestamp(admin);
    const updates = {
      status,
      desiredOutcome: isTerminalAutomationStatus(currentStatus) ? (run.desiredOutcome || currentStatus) : status,
      cleanupState: "complete",
      cleanupCompletedAt: timestamp,
      cleanupErrorCode: null,
      endedAt: run.endedAt || timestamp,
      updatedAt: timestamp,
      ...(persistenceWarning ? {
        persistenceState: "partial",
        persistenceErrorCode: "automation_checkpoint_partial",
      } : {
        persistenceState: "complete",
        persistenceCompletedAt: timestamp,
      }),
    };
    transaction.update(runRef, updates);
    finalized = true;
  });
  return finalized;
}

async function markCleanupError(runRef, runId, error, dependencies = {}) {
  const admin = dependencies.admin || defaultAdmin;
  const code = stableCleanupErrorCode(error);
  await runRef.update({
    cleanupState: "error",
    cleanupErrorCode: code,
    updatedAt: serverTimestamp(admin),
  });
  return {runId, cleaned: false, error: code};
}

function assertWorkspace(snapshot, actorUid) {
  if (!snapshot.exists) throw httpError(404, "workspace_not_found");
  const workspace = snapshot.data() || {};
  if (workspace.ownerUid !== actorUid) throw httpError(403, "workspace_forbidden");
  const lifecycle = normalize(workspace.lifecycle || workspace.status);
  if (workspace.deleted === true || ["deleting", "deleted"].includes(lifecycle)) {
    throw httpError(409, "workspace_deleted");
  }
}

function requireActorUid(actor) {
  const uid = typeof actor === "string" ? actor : actor?.uid;
  if (!uid || typeof uid !== "string") throw httpError(401, "unauthenticated");
  return uid;
}

function validateRunId(value) {
  try {
    return validateAutomationId(String(value || "").trim(), "run_id");
  } catch (error) {
    throw httpError(400, "invalid_run_id", error);
  }
}

function toRunDto(source) {
  const id = source.id || source.runId;
  const data = typeof source.data === "function" ? source.data() || {} : source;
  return serialize({id, ...data});
}

function serverTimestamp(admin) {
  return admin.firestore.FieldValue.serverTimestamp();
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function stableCleanupErrorCode(error) {
  const code = normalize(error?.code || error?.publicMessage || "automation_cleanup_failed");
  return /^[a-z0-9_:-]{1,120}$/.test(code) ? code : "automation_cleanup_failed";
}

function cleanupError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  cleanupAutomationRun,
  createAutomationCleanupService,
  handleAutomationRunEvent,
  stopRun,
};
