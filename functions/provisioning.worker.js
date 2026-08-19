"use strict";

const logger = require("firebase-functions/logger");
const {admin} = require("./backendContext");
const {isRetryableProvisioningError} = require("./provisioning.helpers");
const {sessionStatusUpdate} = require("./sessionLifecycle.helpers");
const {publicGoogleError} = require("./backendUtils.helpers");

function createProvisioningWorker(dependencies = {}) {
  const requireWorkspace = dependencies.requireWorkspace;
  const provisionSessionService = dependencies.provisionSessionService;
  const prepareProvisioningSession = dependencies.prepareProvisioningSession || (async (session) => session);
  if (typeof requireWorkspace !== "function") {
    throw new Error("Provisioning worker requires a requireWorkspace dependency.");
  }
  if (typeof provisionSessionService !== "function") {
    throw new Error("Provisioning worker requires a provisionSessionService dependency.");
  }

  return {
    provisionQueuedSession: (event) => provisionQueuedSession(event, {
      requireWorkspace,
      prepareProvisioningSession,
      provisionSessionService,
      releaseChromeWorkspaceSession: dependencies.releaseChromeWorkspaceSession,
      db: dependencies.db,
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
    const provisioningSession = await dependencies.prepareProvisioningSession(session);
    await dependencies.provisionSessionService(workspace, after.ref, provisioningSession);
    return {provisioned: true, sessionId: after.id};
  } catch (error) {
    const markedFailure = await markProvisioningWorkerFailure(after.ref, session, error, dependencies);
    if (markedFailure && typeof dependencies.releaseChromeWorkspaceSession === "function") {
      try {
        await dependencies.releaseChromeWorkspaceSession(after.ref, session, "provision_failed");
      } catch (releaseError) {
        logger.warn("Chrome workspace reservation release failed after worker setup error", {
          workspaceId,
          sessionId: after.id,
          error: publicGoogleError(releaseError),
        });
      }
    }
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

async function markProvisioningWorkerFailure(sessionRef, session, error, dependencies = {}) {
  const publicError = publicGoogleError(error);
  const updateFailure = (currentSession, writer) => {
    const updates = {
      lastError: publicError,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (currentSession.provisioningOperationId) {
      Object.assign(updates, {
        provisioningState: "failed",
        provisioningAttemptCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
        provisioningRetryable: isRetryableProvisioningError(error),
        provisioningLastError: publicError,
      });
    }
    return writer(sessionStatusUpdate(currentSession, "provision_failed", updates, {
      reconciliationReason: "provisioning_worker_failed",
    }));
  };

  if (dependencies.db && typeof dependencies.db.runTransaction === "function") {
    return dependencies.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(sessionRef);
      if (!snapshot.exists) return false;
      const currentSession = {...session, ...snapshot.data()};
      if (!isQueuedProvisioningSession(currentSession)) return false;
      await updateFailure(currentSession, (update) => transaction.update(sessionRef, update));
      return true;
    });
  }

  await updateFailure(session, (update) => sessionRef.update(update));
  return true;
}

module.exports = {
  createProvisioningWorker,
  isQueuedProvisioningSession,
  markProvisioningWorkerFailure,
  provisionQueuedSession,
};
