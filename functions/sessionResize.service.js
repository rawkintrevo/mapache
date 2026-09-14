"use strict";

const {randomUUID} = require("node:crypto");
const {httpError, toClientDoc} = require("./backendUtils.helpers");
const {isSupportedProvisioningSession} = require("./runnerCatalog.helpers");

const ACTIVE_RESIZE_STATES = new Set(["queued", "running"]);
const RESIZABLE_STATES = new Set(["running", "stopped", "needs_image", "needs_service", "provision_failed", "update_failed", "stop_failed"]);
// Longer than the worker's 540-second execution limit. Never overlap workers.
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

function assertNoActiveResize(session) {
  if (ACTIVE_RESIZE_STATES.has(session.resizeOperationState)) {
    throw httpError(409, "session_resize_in_progress");
  }
}

function createSessionResizeService({admin, db, requireSession, resizeSession, normalizeRequestedSessionResources, now = Date.now}) {
  const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

  async function enqueueResize(uid, workspaceId, sessionId, payload) {
    const {sessionRef} = await requireSession(uid, workspaceId, sessionId);
    const resources = normalizeRequestedSessionResources(payload, {defaultResources: null});
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(sessionRef);
      if (!snapshot.exists) throw httpError(404, "session_not_found");
      const session = snapshot.data();
      if (!isSupportedProvisioningSession(session)) throw httpError(400, "unsupported_runner");
      if (ACTIVE_RESIZE_STATES.has(session.resizeOperationState)) {
        if (session.resizeRequestedResources?.cpu === resources.cpu && session.resizeRequestedResources?.memory === resources.memory) return;
        throw httpError(409, "session_resize_in_progress");
      }
      if (!RESIZABLE_STATES.has(session.status)) throw httpError(409, "session_operation_in_progress");
      transaction.update(sessionRef, {
        resizeOperationId: randomUUID(),
        resizeOperationState: "queued",
        resizeRequestedResources: resources,
        resizeOperationStartedAt: null,
        resizeOperationError: null,
        resizeOperationCompletedAt: null,
        updatedAt: timestamp(),
      });
    });
    return toClientDoc(await sessionRef.get());
  }

  async function resizeQueuedSession(event) {
    const after = event.data?.after;
    if (!after?.exists || after.data().resizeOperationState !== "queued") return;
    const operationId = after.data().resizeOperationId;
    const sessionRef = after.ref;
    const session = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(sessionRef);
      if (!snapshot.exists) return null;
      const current = snapshot.data();
      if (current.resizeOperationId !== operationId || !ACTIVE_RESIZE_STATES.has(current.resizeOperationState)) return null;
      if (current.resizeOperationState === "running" && now() - Number(current.resizeOperationStartedAt) < CLAIM_TIMEOUT_MS) {
        // Retried delivery must wait for completion or the previous invocation's timeout.
        throw new Error("session_resize_worker_active");
      }
      transaction.update(sessionRef, {resizeOperationState: "running", resizeOperationStartedAt: now(), updatedAt: timestamp()});
      return current;
    });
    if (!session) return;
    let failure = null;
    try {
      const result = await resizeSession(session.ownerUid, event.params.workspaceId, after.id, session.resizeRequestedResources);
      if (["provision_failed", "update_failed", "stop_failed", "delete_failed"].includes(result.status)) {
        failure = result.lastError || "session_resize_failed";
      }
    } catch (error) {
      failure = error.publicMessage || "session_resize_failed";
    }
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(sessionRef);
      if (!snapshot.exists || snapshot.data().resizeOperationId !== operationId) return;
      transaction.update(sessionRef, {
        resizeOperationState: failure ? "failed" : "completed",
        resizeOperationError: failure,
        resizeOperationCompletedAt: timestamp(),
        updatedAt: timestamp(),
      });
    });
  }

  return {enqueueResize, resizeQueuedSession};
}

module.exports = {assertNoActiveResize, createSessionResizeService, CLAIM_TIMEOUT_MS};
