"use strict";

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {cleanName, httpError} = require("./backendUtils.helpers");
const {findActiveChromeSession, isChromeSession} = require("./chromeReservation.helpers");
const {isActiveGithubWorkspaceSession} = require("./sessionLifecycle.helpers");
const {isAutomationRuntime} = require("./runtimePaths.helpers");
const {resolveSyncWriterLease} = require("./syncWriterLease.helpers");
const {
  resolveRuntimeReservation,
  runtimeAuthoritySessionReleaseUpdates,
  runtimeSessionAuthorityStateUpdate,
  runtimeStateUpdate,
} = require("./runtimeReservation.helpers");

function createWorkspaceSessionReservationService(dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const firestoreAdmin = dependencies.admin || defaultAdmin;
  return {
    markChromeWorkspaceSessionRunning: (sessionRef, session) => markChromeWorkspaceSessionRunning(
        sessionRef,
        session,
        {firestore, firestoreAdmin},
    ),
    markChromeWorkspaceSessionStopping: (sessionRef, session) => markChromeWorkspaceSessionStopping(
        sessionRef,
        session,
        {firestore, firestoreAdmin},
    ),
    releaseChromeWorkspaceSession: (sessionRef, session, reason) => releaseChromeWorkspaceSession(
        sessionRef,
        session,
        reason,
        {firestore, firestoreAdmin},
    ),
    reserveChromeWorkspaceSession: (workspaceId, sessionRef, session, options = {}) => reserveChromeWorkspaceSession(
        workspaceId,
        sessionRef,
        session,
        options,
        {firestore, firestoreAdmin},
    ),
  };
}

async function reserveChromeWorkspaceSession(workspaceId, sessionRef, session, options = {}, dependencies = {}) {
  const firestore = dependencies.firestore || defaultDb;
  const firestoreAdmin = dependencies.firestoreAdmin || defaultAdmin;
  const workspaceRef = firestore.collection("workspaces").doc(workspaceId);
  return firestore.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    const sessionsSnap = await transaction.get(workspaceRef.collection("sessions"));
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");

    const workspace = workspaceSnap.data() || {};
    const sessions = sessionsSnap.docs.map((doc) => ({id: doc.id, ref: doc.ref, ...doc.data()}));
    const existing = sessions.find((candidate) => candidate.id === sessionRef.id) || null;
    if (existing && existing.ownerUid && session.ownerUid && existing.ownerUid !== session.ownerUid) {
      throw httpError(403, "session_forbidden");
    }

    const runtime = resolveRuntimeReservation(workspace, sessions, session, sessionRef.id,
        options.runtimeOperationId || session.agentRuntimeOperationId || session.provisioningOperationId, {
          enabled: options.newRuntime,
          idempotent: options.create === false ? false : true,
          now: firestoreAdmin.firestore.FieldValue.serverTimestamp(),
        });
    if (runtime.idempotent) return {};
    if (runtime.conflict) {
      throw httpError(409, "agent_runtime_workspace_busy");
    }

    const automationRuntime = isAutomationRuntime(session);

    if (options.singleRunner && !automationRuntime) {
      const activeRunner = sessions.find((candidate) =>
        candidate.id !== sessionRef.id && isActiveWorkspaceRunner(candidate));
      if (activeRunner) throw httpError(409, "workspace_already_has_active_runner");
    }

    const activeChrome = automationRuntime ? null : findActiveChromeSession(sessionsSnap.docs, sessionRef.id);
    if (activeChrome) {
      throw httpError(409, "This workspace already has an active Chrome session. Stop it before creating another one.");
    }
    if (options.githubWorkspace && !automationRuntime) {
      const activeGithub = sessionsSnap.docs.find((doc) => {
        if (doc.id === sessionRef.id) return false;
        const active = doc.data();
        return isActiveGithubWorkspaceSession(active);
      });
      if (activeGithub) {
        throw httpError(409, "This GitHub workspace already has an active session. Stop it before creating another one.");
      }
    }

    const lease = automationRuntime ? {
      sessionUpdates: {
        syncWriterRole: "none",
        syncWriterLeaseId: null,
        syncWriterLeaseUpdatedAt: null,
      },
      workspaceUpdates: {},
    } : resolveSyncWriterLease(
        workspace,
        sessions,
        session,
        sessionRef.id,
        {
          eligible: options.syncWriterEligible,
          now: firestoreAdmin.firestore.FieldValue.serverTimestamp(),
        },
    );
    const workspaceUpdates = automationRuntime ? {} : {
      activeChromeSessionId: sessionRef.id,
      activeChromeSessionState: session.status || "provisioning",
      activeChromeSessionUpdatedAt: firestoreAdmin.firestore.FieldValue.serverTimestamp(),
      updatedAt: firestoreAdmin.firestore.FieldValue.serverTimestamp(),
      ...lease.workspaceUpdates,
      ...runtime.workspaceUpdates,
    };
    if (Object.keys(workspaceUpdates).length) transaction.update(workspaceRef, workspaceUpdates);
    const sessionUpdates = {
      ...lease.sessionUpdates,
      ...runtime.sessionUpdates,
      ...(automationRuntime ? {runtimeKind: "automation"} : {}),
    };
    if (options.create !== false) transaction.set(sessionRef, {...session, ...sessionUpdates});
    else transaction.update(sessionRef, sessionUpdates);
    return sessionUpdates;
  });
}

async function releaseChromeWorkspaceSession(sessionRef, session, reason, dependencies = {}) {
  if ((!isChromeSession(session) && !isAutomationRuntime(session)) || !session.workspaceId) return;
  const firestore = dependencies.firestore || defaultDb;
  const firestoreAdmin = dependencies.firestoreAdmin || defaultAdmin;
  const workspaceRef = firestore.collection("workspaces").doc(session.workspaceId);
  await firestore.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists) return;
    const automationRuntime = isAutomationRuntime(session);
    if (!automationRuntime && workspaceSnap.data().activeChromeSessionId !== sessionRef.id) return;
    const now = firestoreAdmin.firestore.FieldValue.serverTimestamp();
    const reasonState = reason === "provision_failed" || reason === "needs_image" ? "failed" : "stopped";
    if (automationRuntime) {
      transaction.update(sessionRef, runtimeSessionAuthorityStateUpdate(
          {...session, id: sessionRef.id}, reasonState, now, {release: true},
      ));
      return;
    }
    transaction.update(workspaceRef, {
      activeChromeSessionId: firestoreAdmin.firestore.FieldValue.delete(),
      activeChromeSessionState: reason ? `released:${cleanName(reason)}` : "released",
      activeChromeSessionReleasedAt: now,
      updatedAt: now,
      ...runtimeStateUpdate(workspaceSnap.data(), {...session, id: sessionRef.id}, reasonState, now, {release: true}),
    });
    const sessionRuntimeUpdates = runtimeAuthoritySessionReleaseUpdates(session, now);
    if (Object.keys(sessionRuntimeUpdates).length) transaction.update(sessionRef, sessionRuntimeUpdates);
  });
}

async function markChromeWorkspaceSessionRunning(sessionRef, session, dependencies = {}) {
  return updateChromeWorkspaceRuntimeState(sessionRef, session, "running", dependencies);
}

async function markChromeWorkspaceSessionStopping(sessionRef, session, dependencies = {}) {
  return updateChromeWorkspaceRuntimeState(sessionRef, session, "stopping", dependencies);
}

async function updateChromeWorkspaceRuntimeState(sessionRef, session, state, dependencies = {}) {
  if ((!isChromeSession(session) && !isAutomationRuntime(session)) || !session.workspaceId) return false;
  const firestore = dependencies.firestore || defaultDb;
  const firestoreAdmin = dependencies.firestoreAdmin || defaultAdmin;
  const workspaceRef = firestore.collection("workspaces").doc(session.workspaceId);
  return firestore.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists) return false;
    const now = firestoreAdmin.firestore.FieldValue.serverTimestamp();
    if (isAutomationRuntime(session)) {
      transaction.update(sessionRef, runtimeSessionAuthorityStateUpdate(
          {...session, id: sessionRef.id}, state, now,
      ));
      return true;
    }
    const updates = runtimeStateUpdate(workspaceSnap.data(), {...session, id: sessionRef.id}, state, now);
    if (!Object.keys(updates).length) return false;
    transaction.update(workspaceRef, updates);
    return true;
  });
}

function isActiveWorkspaceRunner(session = {}) {
  return !isAutomationRuntime(session) && ![
    "stopped",
    "inactive",
    "needs_image",
    "needs_service",
    "provision_failed",
    "update_failed",
    "stop_failed",
    "delete_failed",
  ].includes(String(session.status || "").trim().toLowerCase());
}

module.exports = {
  createWorkspaceSessionReservationService,
  markChromeWorkspaceSessionRunning,
  markChromeWorkspaceSessionStopping,
  releaseChromeWorkspaceSession,
  reserveChromeWorkspaceSession,
};
