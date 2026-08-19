"use strict";

const logger = require("firebase-functions/logger");
const {admin} = require("./backendContext");
const {isRetryableProvisioningError} = require("./provisioning.helpers");
const {sessionStatusUpdate} = require("./sessionLifecycle.helpers");
const {publicGoogleError} = require("./backendUtils.helpers");

function createProvisioningWorker(dependencies = {}) {
  const requireWorkspace = dependencies.requireWorkspace;
  const provisionSessionService = dependencies.provisionSessionService;
  if (typeof requireWorkspace !== "function") {
    throw new Error("Provisioning worker requires a requireWorkspace dependency.");
  }
  if (typeof provisionSessionService !== "function") {
    throw new Error("Provisioning worker requires a provisionSessionService dependency.");
  }

  return {
    provisionQueuedSession: (event) => provisionQueuedSession(event, {
      requireWorkspace,
      provisionSessionService,
    }),
  };
}

async function provisionQueuedSession(event, dependencies) {
  const after = event && event.data && event.data.after;
  if (!after || !after.exists) return {skipped: "deleted"};

  const session = {id: after.id, ...after.data()};
  if (!isQueuedProvisioningSession(session)) return {skipped: "not_queued"};

  const workspaceId = event.params && event.params.workspaceId || session.workspaceId;
  try {
    if (!session.provisioningOperationId) {
      const error = new Error("Queued session is missing a provisioning operation ID.");
      error.code = "missing_provisioning_operation_id";
      throw error;
    }
    const workspace = await dependencies.requireWorkspace(session.ownerUid, workspaceId);
    await dependencies.provisionSessionService(workspace, after.ref, session);
    return {provisioned: true, sessionId: after.id};
  } catch (error) {
    await markProvisioningWorkerFailure(after.ref, session, error);
    logger.error("queued session provisioning worker failed", {
      workspaceId,
      sessionId: after.id,
      error: publicGoogleError(error),
    });
    return {provisioned: false, sessionId: after.id};
  }
}

function isQueuedProvisioningSession(session = {}) {
  return session.status === "provisioning" && session.provisioningState === "queued";
}

async function markProvisioningWorkerFailure(sessionRef, session, error) {
  const publicError = publicGoogleError(error);
  const updates = {
    lastError: publicError,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (session.provisioningOperationId) {
    Object.assign(updates, {
      provisioningState: "failed",
      provisioningAttemptCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      provisioningRetryable: isRetryableProvisioningError(error),
      provisioningLastError: publicError,
    });
  }
  await sessionRef.update(sessionStatusUpdate(session, "provision_failed", updates, {
    reconciliationReason: "provisioning_worker_failed",
  }));
}

module.exports = {
  createProvisioningWorker,
  isQueuedProvisioningSession,
  markProvisioningWorkerFailure,
  provisionQueuedSession,
};
