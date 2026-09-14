"use strict";

const logger = require("firebase-functions/logger");
const {admin, db} = require("./backendContext");
const {
  clearWorkspaceSyncWriterLease,
  isActiveSyncWriterSession,
  isSyncWriterEligible,
  resolveSyncWriterLease,
} = require("./syncWriterLease.helpers");
const {runtimeAuthorityReleaseUpdates} = require("./runtimeReservation.helpers");

function createSyncWriterLeaseService(dependencies = {}) {
  const firestore = dependencies.db || db;

  return {
    releaseWorkspaceSyncWriterLease: (sessionRef, session, reason) =>
      releaseWorkspaceSyncWriterLease(sessionRef, session, reason, {firestore}),
    reconcileWorkspaceSyncWriterLease: (workspaceId) =>
      reconcileWorkspaceSyncWriterLease(workspaceId, {firestore}),
  };
}

async function releaseWorkspaceSyncWriterLease(sessionRef, session = {}, reason, dependencies = {}) {
  const firestore = dependencies.firestore || db;
  if (!firestore || !session.workspaceId) return false;

  return firestore.runTransaction(async (transaction) => {
    const workspaceRef = firestore.collection("workspaces").doc(session.workspaceId);
    const sessionsRef = workspaceRef.collection("sessions");
    const [workspaceSnap, sessionsSnap] = await Promise.all([
      transaction.get(workspaceRef),
      transaction.get(sessionsRef),
    ]);
    if (!workspaceSnap.exists) return false;

    const workspace = workspaceSnap.data() || {};
    const sessionId = sessionRef.id;
    const releasingSession = sessionsSnap.docs.find((doc) => doc.id === sessionId);
    const update = {
      syncWriterRole: "none",
      syncWriterLeaseId: null,
      syncWriterLeaseUpdatedAt: null,
    };
    const now = admin.firestore.FieldValue.serverTimestamp();
    const runtimeRelease = runtimeAuthorityReleaseUpdates(
        workspace,
        {...session, id: sessionId},
        now,
    );
    const workspaceRuntimeUpdates = runtimeRelease.workspaceUpdates;
    const sessionReleaseUpdates = {...update, ...runtimeRelease.sessionUpdates};
    if (workspace.syncWriterSessionId !== sessionId) {
      if (Object.keys(workspaceRuntimeUpdates).length) transaction.update(workspaceRef, workspaceRuntimeUpdates);
      if (releasingSession) transaction.update(sessionRef, sessionReleaseUpdates);
      return false;
    }

    const candidates = sessionsSnap.docs
        .filter((doc) => doc.id !== sessionId)
        .map((doc) => ({id: doc.id, ref: doc.ref, ...doc.data()}))
        .filter(isActiveSyncWriterSession);
    const replacement = candidates[0] || null;
    let workspaceUpdates = {...workspaceRuntimeUpdates};
    if (replacement) {
      const lease = resolveSyncWriterLease(
          {...workspace, syncWriterSessionId: null, syncWriterLeaseId: null},
          [],
          replacement,
          replacement.id,
          {eligible: true, now: admin.firestore.FieldValue.serverTimestamp()},
      );
      Object.assign(workspaceUpdates, lease.workspaceUpdates);
      transaction.update(replacement.ref, {
        ...lease.sessionUpdates,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      Object.assign(workspaceUpdates, clearWorkspaceSyncWriterLease(admin.firestore.FieldValue.serverTimestamp()));
    }
    if (Object.keys(workspaceUpdates).length) transaction.update(workspaceRef, workspaceUpdates);
    if (releasingSession) transaction.update(sessionRef, sessionReleaseUpdates);
    return Boolean(replacement);
  }).catch((error) => {
    logger.warn("workspace sync-writer lease release failed", {
      workspaceId: session.workspaceId,
      sessionId: sessionRef.id,
      reason: reason || "unspecified",
      error: error.message || String(error),
    });
    throw error;
  });
}

async function reconcileWorkspaceSyncWriterLease(workspaceId, dependencies = {}) {
  const firestore = dependencies.firestore || db;
  if (!firestore || !workspaceId) return {status: "skipped"};

  return firestore.runTransaction(async (transaction) => {
    const workspaceRef = firestore.collection("workspaces").doc(workspaceId);
    const sessionsRef = workspaceRef.collection("sessions");
    const [workspaceSnap, sessionsSnap] = await Promise.all([
      transaction.get(workspaceRef),
      transaction.get(sessionsRef),
    ]);
    if (!workspaceSnap.exists) return {status: "missing"};

    const workspace = workspaceSnap.data() || {};
    const sessions = sessionsSnap.docs.map((doc) => ({id: doc.id, ref: doc.ref, ...doc.data()}));
    const owner = sessions.find((session) => session.id === workspace.syncWriterSessionId);
    if (owner && isActiveSyncWriterSession(owner)) {
      const lease = resolveSyncWriterLease(
          workspace,
          sessions,
          owner,
          owner.id,
          {eligible: true, leaseId: workspace.syncWriterLeaseId, now: admin.firestore.FieldValue.serverTimestamp()},
      );
      transaction.update(workspaceRef, lease.workspaceUpdates);
      transaction.update(owner.ref, lease.sessionUpdates);
      return {status: "active", sessionId: owner.id};
    }

    const replacement = sessions.find(isActiveSyncWriterSession);
    if (!replacement) {
      transaction.update(workspaceRef, clearWorkspaceSyncWriterLease(admin.firestore.FieldValue.serverTimestamp()));
      return {status: "cleared"};
    }

    const lease = resolveSyncWriterLease(
        {...workspace, syncWriterSessionId: null, syncWriterLeaseId: null},
        [],
        replacement,
        replacement.id,
        {eligible: true, now: admin.firestore.FieldValue.serverTimestamp()},
    );
    transaction.update(workspaceRef, lease.workspaceUpdates);
    transaction.update(replacement.ref, {
      ...lease.sessionUpdates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (owner && owner.ref) transaction.update(owner.ref, {
      syncWriterRole: "none",
      syncWriterLeaseId: null,
      syncWriterLeaseUpdatedAt: null,
    });
    return {status: "reassigned", sessionId: replacement.id};
  });
}

module.exports = {
  createSyncWriterLeaseService,
  reconcileWorkspaceSyncWriterLease,
  releaseWorkspaceSyncWriterLease,
};
