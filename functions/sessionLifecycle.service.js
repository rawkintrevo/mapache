"use strict";

const crypto = require("crypto");
const logger = require("firebase-functions/logger");
const {
  DEFAULT_BUCKET,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_REGION,
} = require("./backendConfig");
const {
  cleanName,
  cloudRunServiceName,
  httpError,
  latestTimestampMillis,
  positiveNumber,
  toClientDoc,
} = require("./backendUtils.helpers");
const {isChromeSession} = require("./chromeReservation.helpers");
const {mcpConfigForRunner} = require("./mcpConfig.helpers");
const {
  initialProvisioningMetadata,
  isValidCloudRunServiceId,
  resolveCloudRunServiceId,
} = require("./provisioning.helpers");
const {
  accrueSessionUsage,
  isTerminalSessionStatus,
  sessionUsageRecord,
} = require("./userUsage.service");
const {
  isActiveGithubWorkspaceSession,
  isShellSession,
  sessionStatusUpdate,
} = require("./sessionLifecycle.helpers");

function createSessionLifecycleService(dependencies = {}) {
  return {
    deleteSession: (uid, workspaceId, sessionId) => deleteSession(uid, workspaceId, sessionId, dependencies),
    markSessionStopped: (sessionRef, session, reason) => markSessionStopped(sessionRef, session, reason, dependencies),
    reapIdleSessions: () => reapIdleSessions(dependencies),
    requireSession: (uid, workspaceId, sessionId) => requireSession(uid, workspaceId, sessionId, dependencies),
    renameSession: (uid, workspaceId, sessionId, payload) => renameSession(uid, workspaceId, sessionId, payload, dependencies),
    resizeSession: (uid, workspaceId, sessionId, payload) => resizeSession(uid, workspaceId, sessionId, payload, dependencies),
    restartSession: (uid, workspaceId, sessionId) => restartSession(uid, workspaceId, sessionId, dependencies),
    stopSession: (uid, workspaceId, sessionId) => stopSession(uid, workspaceId, sessionId, dependencies),
  };
}

async function requireSession(uid, workspaceId, sessionId, dependencies = {}) {
  await dependencies.requireWorkspace(uid, workspaceId);
  const sessionRef = dependencies.sessionCollection(workspaceId).doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw httpError(404, "session_not_found");
  const data = sessionSnap.data();
  if (data.ownerUid && data.ownerUid !== uid) throw httpError(403, "session_forbidden");
  return {sessionRef, sessionSnap};
}

async function renameSession(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const {sessionRef} = await requireSession(uid, workspaceId, sessionId, dependencies);
  const name = cleanName(payload && payload.name);
  if (!name) throw httpError(400, "invalid_session_name");
  await sessionRef.update({
    name,
    updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
  });
  return toClientDoc(await sessionRef.get());
}

async function resizeSession(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId, dependencies);
  const resources = dependencies.normalizeRequestedSessionResources(payload, {defaultResources: null});
  const resizedAt = dependencies.admin.firestore.Timestamp.now();
  await sessionRef.update(sessionStatusUpdate(sessionSnap.data(), "resizing", {
    ...accrueSessionUsage(sessionSnap.data(), resizedAt),
    resources,
    updatedAt: resizedAt,
  }));
  await dependencies.patchSessionService(sessionRef, {...sessionSnap.data(), resources});
  return toClientDoc(await sessionRef.get());
}

async function restartSession(uid, workspaceId, sessionId, dependencies = {}) {
  const workspace = await dependencies.requireWorkspace(uid, workspaceId);
  const sessionRef = dependencies.sessionCollection(workspaceId).doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw httpError(404, "session_not_found");
  const session = sessionSnap.data();
  if (session.ownerUid && session.ownerUid !== uid) throw httpError(403, "session_forbidden");

  const recreatingSessionService = shouldRecreateSessionServiceOnRestart(session);
  if (recreatingSessionService && isGithubWorkspace(workspace) && !isShellSession(session)) {
    await assertNoActiveGithubWorkspaceSession(workspaceId, sessionId, session, dependencies);
  }
  if (recreatingSessionService && isChromeSession(session)) {
    await dependencies.reserveChromeWorkspaceSession(workspaceId, sessionRef, session, {
      create: false,
      githubWorkspace: isGithubWorkspace(workspace),
      syncWriterEligible: true,
    });
  }

  const restartedAt = dependencies.admin.firestore.Timestamp.now();
  const browserAccessTokenSecret = session.browserAccessTokenSecret || crypto.randomBytes(32).toString("hex");
  const restartNonce = Date.now().toString();
  const restartUpdate = sessionStatusUpdate(session, recreatingSessionService ? "provisioning" : "restarting", {
    browserAccessTokenSecret,
    mcpConfig: mcpConfigForRunner(workspace),
    restartNonce,
    restartedAt,
    stoppedAt: null,
    autoStoppedAt: null,
    stopReason: null,
    serviceUrl: null,
    lastError: null,
    updatedAt: restartedAt,
  });

  if (recreatingSessionService) {
    Object.assign(restartUpdate, initialProvisioningMetadata(crypto.randomUUID()));
  }

  if (!Array.isArray(session.environmentEntryIds) && Array.isArray(session.genericEnvironmentEntryIds)) {
    restartUpdate.environmentEntryIds = [...new Set(session.genericEnvironmentEntryIds)];
  }

  if (recreatingSessionService) {
    Object.assign(restartUpdate, {
      ...accrueSessionUsage(session, restartedAt),
      usageAccountedAt: null,
      activeSocketCount: 0,
    });
  }

  await sessionRef.update(restartUpdate);

  const serviceId = resolveCloudRunServiceId(sessionId, session.serviceId);
  const serviceName = isValidCloudRunServiceId(session.serviceId) && session.serviceName ?
    session.serviceName : cloudRunServiceName(session.region || DEFAULT_REGION, serviceId);
  const restartedSession = {
    ...session,
    ...restartUpdate,
    browserAccessTokenSecret,
    restartNonce,
    workspaceId,
    workspaceStorageBucket: session.workspaceStorageBucket || workspace.bucket || DEFAULT_BUCKET,
    workspaceStoragePrefix: session.workspaceStoragePrefix || workspace.storagePrefix,
    serviceId,
    serviceName,
  };

  if (recreatingSessionService && !isChromeSession(session)) {
    await dependencies.reserveWorkspaceSyncSession(workspaceId, sessionRef, restartedSession, {
      create: false,
      syncWriterEligible: true,
    });
  }

  if (recreatingSessionService) {
    await dependencies.provisionSessionService(
        workspace,
        sessionRef,
        await dependencies.prepareSessionForProvisioning(restartedSession),
    );
  } else {
    await dependencies.patchSessionService(sessionRef, restartedSession, {restart: true});
  }

  return toClientDoc(await sessionRef.get());
}

async function stopSession(uid, workspaceId, sessionId, dependencies = {}) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId, dependencies);
  await sessionRef.update(sessionStatusUpdate(sessionSnap.data(), "stopping", {
    updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
  }));
  await dependencies.deleteSessionService(sessionRef, sessionSnap.data(), {reason: "manual"});
  return toClientDoc(await sessionRef.get());
}

async function deleteSession(uid, workspaceId, sessionId, dependencies = {}) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId, dependencies);
  await sessionRef.update(sessionStatusUpdate(sessionSnap.data(), "deleting", {
    updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
  }));
  const serviceDeleted = await dependencies.deleteSessionService(sessionRef, sessionSnap.data(), {reason: "deleted"});
  if (!serviceDeleted) {
    throw httpError(502, "session_delete_failed");
  }
  await sessionRef.delete();
  return {ok: true};
}

async function markSessionStopped(sessionRef, session, reason, dependencies = {}) {
  try {
    await dependencies.releaseWorkspaceSyncWriterLease(sessionRef, session, reason);
  } catch (error) {
    logger.warn("Workspace sync-writer lease release failed while stopping session", {
      workspaceId: session.workspaceId,
      sessionId: sessionRef.id,
      reason: reason || "unspecified",
      error: error.message || String(error),
    });
  }
  const stoppedAt = dependencies.admin.firestore.Timestamp.now();
  const usageRecord = sessionUsageRecord(sessionRef, session, stoppedAt);
  const stopped = sessionStatusUpdate(session, "stopped", {
    activeSocketCount: 0,
    serviceUrl: null,
    stoppedAt,
    lastError: null,
    updatedAt: stoppedAt,
  }, {reconciliationReason: reason || "service_deleted"});
  if (reason) stopped.stopReason = reason;
  if (reason === "idle_timeout") stopped.autoStoppedAt = stoppedAt;
  if (isChromeSession(session)) {
    await dependencies.db.runTransaction(async (transaction) => {
      const workspaceRef = dependencies.db.collection("workspaces").doc(session.workspaceId);
      const workspaceSnap = await transaction.get(workspaceRef);
      if (usageRecord) transaction.set(usageRecord.ref, usageRecord.data, {merge: true});
      transaction.update(sessionRef, stopped);
      if (workspaceSnap.exists && workspaceSnap.data().activeChromeSessionId === sessionRef.id) {
        transaction.update(workspaceRef, {
          activeChromeSessionId: dependencies.admin.firestore.FieldValue.delete(),
          activeChromeSessionState: "released",
          activeChromeSessionReleasedAt: stoppedAt,
          updatedAt: stoppedAt,
        });
      }
    });
    return;
  }
  if (usageRecord) {
    stopped.usageAccountedAt = stoppedAt;
    const batch = dependencies.db.batch();
    batch.set(usageRecord.ref, usageRecord.data, {merge: true});
    batch.update(sessionRef, stopped);
    await batch.commit();
    return;
  }
  await sessionRef.update(stopped);
}

async function reapIdleSessions(dependencies = {}) {
  const snap = await dependencies.db.collectionGroup("sessions")
      .where("status", "==", "running")
      .get();
  const now = Date.now();
  const results = await Promise.allSettled(snap.docs.map(async (doc) => {
    const session = doc.data();
    if (!isIdleSession(session, now)) return false;
    logger.info("stopping idle session", {
      workspaceId: session.workspaceId,
      sessionId: doc.id,
      serviceId: session.serviceId,
    });
    await doc.ref.update(sessionStatusUpdate(session, "stopping", {
      stopReason: "idle_timeout",
      updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
    }));
    await dependencies.deleteSessionService(doc.ref, session, {reason: "idle_timeout"});
    return true;
  }));

  const stopped = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const failed = results.filter((result) => result.status === "rejected");
  failed.forEach((result) => logger.error("idle session stop failed", result.reason));
  logger.info("idle session reap complete", {checked: snap.size, stopped, failed: failed.length});
  return {checked: snap.size, stopped, failed: failed.length};
}

async function assertNoActiveGithubWorkspaceSession(workspaceId, sessionId, session, dependencies) {
  await dependencies.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(dependencies.sessionCollection(workspaceId));
    const activeSession = snap.docs.find((doc) => {
      if (doc.id === sessionId) return false;
      const active = doc.data();
      return isActiveGithubWorkspaceSession(active) && !isShellSession(active) && !isShellSession(session);
    });
    if (activeSession) {
      throw httpError(409, "This GitHub workspace already has an active session. Stop it before restarting this one.");
    }
  });
}

function shouldRecreateSessionServiceOnRestart(session) {
  if (isTerminalSessionStatus(session && session.status)) return true;
  if (cleanName(session && session.status) !== "update_failed") return false;
  if (!session.serviceUrl) return true;
  const lastError = String(session.lastError || "").toLowerCase();
  return lastError.includes("\"code\":404") || lastError.includes("does not exist") || lastError.includes("not found");
}

function isGithubWorkspace(workspace) {
  return workspace && workspace.source && workspace.source.type === "github";
}

function isIdleSession(session, now) {
  const idleTimeoutMinutes = Math.min(
      positiveNumber(session.idleTimeoutMinutes, DEFAULT_IDLE_TIMEOUT_MINUTES),
      DEFAULT_IDLE_TIMEOUT_MINUTES,
  );
  const idleSince = latestTimestampMillis(
      session.lastActivityAt,
      session.lastConnectedAt,
      session.lastDisconnectedAt,
      session.updatedAt,
      session.createdAt,
  );
  if (!idleSince) return false;
  return now - idleSince >= idleTimeoutMinutes * 60 * 1000;
}

module.exports = {createSessionLifecycleService};
