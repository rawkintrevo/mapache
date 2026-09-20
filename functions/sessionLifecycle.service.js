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
const {isAutomationRuntime} = require("./runtimePaths.helpers");
const {assertNoActiveResize} = require("./sessionResize.service");
const {sessionSourceMetadata} = require("./github.service");
const {mcpConfigForRunner} = require("./mcpConfig.helpers");
const {sessionSyncPolicyMetadata} = require("./sessionCreation.service");
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
  normalizeSessionState,
  sessionStatusUpdate,
} = require("./sessionLifecycle.helpers");
const {isSupportedProvisioningSession, resolveSessionCapabilities} = require("./runnerCatalog.helpers");
const {
  isMarkedRuntimeSession,
  runtimeSessionStateUpdate,
  runtimeStateUpdate,
} = require("./runtimeReservation.helpers");

function createSessionLifecycleService(dependencies = {}) {
  return {
    deleteSession: (uid, workspaceId, sessionId) => deleteSession(uid, workspaceId, sessionId, dependencies),
    markSessionStopped: (sessionRef, session, reason) => markSessionStopped(sessionRef, session, reason, dependencies),
    reapIdleSessions: () => reapIdleSessions(dependencies),
    requireSession: (uid, workspaceId, sessionId) => requireSession(uid, workspaceId, sessionId, dependencies),
    renameSession: (uid, workspaceId, sessionId, payload) => renameSession(uid, workspaceId, sessionId, payload, dependencies),
    setSessionLongRunning: (uid, workspaceId, sessionId, payload) => setSessionLongRunning(uid, workspaceId, sessionId, payload, dependencies),
    resizeSession: (uid, workspaceId, sessionId, payload) => resizeSession(uid, workspaceId, sessionId, payload, dependencies),
    restartSession: (uid, workspaceId, sessionId) => restartSession(uid, workspaceId, sessionId, dependencies),
    stopSession: (uid, workspaceId, sessionId) => stopSession(uid, workspaceId, sessionId, dependencies),
  };
}

async function requireSession(uid, workspaceId, sessionId, dependencies = {}) {
  const workspace = await dependencies.requireWorkspace(uid, workspaceId);
  const sessionRef = dependencies.sessionCollection(workspaceId).doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw httpError(404, "session_not_found");
  const data = sessionSnap.data();
  if (data.ownerUid && data.ownerUid !== uid) throw httpError(403, "session_forbidden");
  return {sessionRef, sessionSnap, workspace};
}

async function renameSession(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId, dependencies);
  assertMainSession(sessionSnap.data());
  const name = cleanName(payload && payload.name);
  if (!name) throw httpError(400, "invalid_session_name");
  await sessionRef.update({
    name,
    updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
  });
  return toClientDoc(await sessionRef.get());
}

async function setSessionLongRunning(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId, dependencies);
  const session = sessionSnap.data();
  assertMainSession(session);
  if (!isMarkedRuntimeSession(session)) throw httpError(409, "long_running_unavailable");
  if (!payload || typeof payload.enabled !== "boolean") throw httpError(400, "invalid_long_running");
  await sessionRef.update({
    longRunning: payload.enabled,
    updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
  });
  return toClientDoc(await sessionRef.get());
}

async function resizeSession(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const {sessionRef, sessionSnap, workspace} = await requireSession(uid, workspaceId, sessionId, dependencies);
  const session = sessionSnap.data();
  assertMainSession(session);
  assertSupportedSessionLaunch(session);
  const resources = dependencies.normalizeRequestedSessionResources(payload, {defaultResources: null});
  if (isMarkedRuntimeSession(session)) {
    assertRuntimeRecreationAllowed(session);
    const stoppedSession = await stopSessionBeforeRecreation(sessionRef, session, dependencies);
    return recreateSessionService(workspace, workspaceId, sessionRef, stoppedSession, dependencies, {resources});
  }
  const resizedAt = dependencies.admin.firestore.Timestamp.now();
  await sessionRef.update(sessionStatusUpdate(session, "resizing", {
    ...accrueSessionUsage(session, resizedAt),
    resources,
    updatedAt: resizedAt,
  }));
  await dependencies.patchSessionService(sessionRef, {...session, resources});
  return toClientDoc(await sessionRef.get());
}

async function restartSession(uid, workspaceId, sessionId, dependencies = {}) {
  const workspace = await dependencies.requireWorkspace(uid, workspaceId);
  const sessionRef = dependencies.sessionCollection(workspaceId).doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw httpError(404, "session_not_found");
  let session = sessionSnap.data();
  if (session.ownerUid && session.ownerUid !== uid) throw httpError(403, "session_forbidden");
  assertMainSession(session);
  assertNoActiveResize(session);
  if (session.resizeOperationState === "failed") {
    await sessionRef.update({resizeOperationState: null, resizeOperationError: null});
    session = {...session, resizeOperationState: null, resizeOperationError: null};
  }
  assertSupportedSessionLaunch(session);
  if (isMarkedRuntimeSession(session)) {
    assertRuntimeRecreationAllowed(session);
    session = await stopSessionBeforeRecreation(sessionRef, session, dependencies);
    return recreateSessionService(workspace, workspaceId, sessionRef, session, dependencies);
  }
  if (normalizeSessionState(session.status) === "stop_failed") throw httpError(409, "session_stop_failed");

  const recreatingSessionService = shouldRecreateSessionServiceOnRestart(session);
  if (recreatingSessionService && isGithubWorkspace(workspace)) {
    await assertNoActiveGithubWorkspaceSession(workspaceId, sessionId, session, dependencies);
  }
  let syncWriterUpdates = {};
  const restartOperationId = recreatingSessionService ? crypto.randomUUID() : "";
  if (recreatingSessionService && isChromeSession(session)) {
    syncWriterUpdates = await dependencies.reserveChromeWorkspaceSession(workspaceId, sessionRef, session, {
      create: false,
      githubWorkspace: isGithubWorkspace(workspace),
      newRuntime: isMarkedRuntimeSession(session),
      runtimeOperationId: restartOperationId,
      singleRunner: true,
      syncWriterEligible: true,
    }) || {};
  }

  const restartedAt = dependencies.admin.firestore.Timestamp.now();
  const browserAccessTokenSecret = session.browserAccessTokenSecret || crypto.randomBytes(32).toString("hex");
  const restartNonce = Date.now().toString();
  const capabilities = resolveSessionCapabilities(session);
  const restartUpdate = sessionStatusUpdate(session, recreatingSessionService ? "provisioning" : "restarting", {
    browserAccessTokenSecret,
    capabilities,
    mcpConfig: mcpConfigForRunner(workspace),
    ...authoritativeSessionSourceMetadata(workspace),
    ...sessionSyncPolicyMetadata(workspace),
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
    Object.assign(restartUpdate, initialProvisioningMetadata(restartOperationId));
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
    ...syncWriterUpdates,
    browserAccessTokenSecret,
    restartNonce,
    workspaceId,
    workspaceStorageBucket: session.workspaceStorageBucket || workspace.bucket || DEFAULT_BUCKET,
    workspaceStoragePrefix: session.workspaceStoragePrefix || workspace.storagePrefix,
    serviceId,
    serviceName,
  };

  if (recreatingSessionService && !isChromeSession(session)) {
    syncWriterUpdates = await dependencies.reserveWorkspaceSyncSession(workspaceId, sessionRef, restartedSession, {
      create: false,
      syncWriterEligible: true,
    }) || {};
    Object.assign(restartedSession, syncWriterUpdates);
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

async function recreateSessionService(workspace, workspaceId, sessionRef, session, dependencies, options = {}) {
  const restartOperationId = crypto.randomUUID();
  if (isGithubWorkspace(workspace)) {
    await assertNoActiveGithubWorkspaceSession(workspaceId, sessionRef.id, session, dependencies);
  }

  let syncWriterUpdates = {};
  if (isChromeSession(session)) {
    syncWriterUpdates = await dependencies.reserveChromeWorkspaceSession(workspaceId, sessionRef, session, {
      create: false,
      githubWorkspace: isGithubWorkspace(workspace),
      newRuntime: isMarkedRuntimeSession(session),
      runtimeOperationId: restartOperationId,
      singleRunner: true,
      syncWriterEligible: true,
    }) || {};
  }

  const restartedAt = dependencies.admin.firestore.Timestamp.now();
  const browserAccessTokenSecret = session.browserAccessTokenSecret || crypto.randomBytes(32).toString("hex");
  const restartNonce = Date.now().toString();
  const capabilities = resolveSessionCapabilities(session);
  const recoveryWarning = session.agentRuntimeRecoveryWarning === "interrupted" ?
    "runtime_interrupted_checkpoint_recovery_required" : null;
  const restartUpdate = sessionStatusUpdate(session, "provisioning", {
    browserAccessTokenSecret,
    capabilities,
    mcpConfig: mcpConfigForRunner(workspace),
    ...authoritativeSessionSourceMetadata(workspace),
    ...sessionSyncPolicyMetadata(workspace),
    restartNonce,
    restartedAt,
    stoppedAt: null,
    autoStoppedAt: null,
    stopReason: null,
    serviceUrl: null,
    lastError: recoveryWarning,
    updatedAt: restartedAt,
    ...(options.resources ? {resources: options.resources} : {}),
    ...(recoveryWarning ? {agentRuntimeRecoveryWarning: "interrupted"} : {}),
  });
  Object.assign(restartUpdate, initialProvisioningMetadata(restartOperationId));

  if (!Array.isArray(session.environmentEntryIds) && Array.isArray(session.genericEnvironmentEntryIds)) {
    restartUpdate.environmentEntryIds = [...new Set(session.genericEnvironmentEntryIds)];
  }

  Object.assign(restartUpdate, {
    ...accrueSessionUsage(session, restartedAt),
    usageAccountedAt: null,
    activeSocketCount: 0,
  });

  await sessionRef.update(restartUpdate);

  const serviceId = resolveCloudRunServiceId(sessionRef.id, session.serviceId);
  const serviceName = isValidCloudRunServiceId(session.serviceId) && session.serviceName ?
    session.serviceName : cloudRunServiceName(session.region || DEFAULT_REGION, serviceId);
  const restartedSession = {
    ...session,
    ...restartUpdate,
    ...syncWriterUpdates,
    browserAccessTokenSecret,
    restartNonce,
    workspaceId,
    workspaceStorageBucket: session.workspaceStorageBucket || workspace.bucket || DEFAULT_BUCKET,
    workspaceStoragePrefix: session.workspaceStoragePrefix || workspace.storagePrefix,
    serviceId,
    serviceName,
  };

  if (!isChromeSession(session)) {
    syncWriterUpdates = await dependencies.reserveWorkspaceSyncSession(workspaceId, sessionRef, restartedSession, {
      create: false,
      syncWriterEligible: true,
    }) || {};
    Object.assign(restartedSession, syncWriterUpdates);
  }

  await dependencies.provisionSessionService(
      workspace,
      sessionRef,
      await dependencies.prepareSessionForProvisioning(restartedSession),
  );
  return toClientDoc(await sessionRef.get());
}

async function stopSessionBeforeRecreation(sessionRef, session, dependencies) {
  const status = normalizeSessionState(session.status);
  if (["stopped", "needs_image"].includes(status)) return session;

  const stoppingAt = dependencies.admin.firestore.Timestamp.now();
  await sessionRef.update(sessionStatusUpdate(session, "stopping", {
    ...runtimeSessionStateUpdate(session, "stopping"),
    updatedAt: stoppingAt,
  }));
  if (isChromeSession(session) && typeof dependencies.markChromeWorkspaceSessionStopping === "function") {
    await dependencies.markChromeWorkspaceSessionStopping(sessionRef, session);
  }

  let serviceDeleted = false;
  try {
    serviceDeleted = await dependencies.deleteSessionService(sessionRef, session, {
      reason: "manual",
      recoveryWarning: "interrupted",
    });
  } catch (error) {
    await recordRuntimeStopFailure(sessionRef, session, dependencies, error);
  }
  if (!serviceDeleted) {
    const latestSnap = await sessionRef.get();
    if (!latestSnap.exists || normalizeSessionState(latestSnap.data().status) !== "stop_failed") {
      await recordRuntimeStopFailure(sessionRef, session, dependencies);
    }
    throw httpError(502, "session_stop_failed");
  }

  const stoppedSnap = await sessionRef.get();
  const stoppedSession = stoppedSnap.exists ? stoppedSnap.data() : {...session, status: "stopped"};
  if (normalizeSessionState(stoppedSession.status) !== "stopped") {
    await sessionRef.update(sessionStatusUpdate(stoppedSession, "stopped", {
      ...runtimeSessionStateUpdate(stoppedSession, "stopped"),
      serviceUrl: null,
      updatedAt: dependencies.admin.firestore.Timestamp.now(),
    }, {reconciliationReason: "cloud_run_recreation_delete_confirmed"}));
    return {...stoppedSession, status: "stopped", serviceUrl: null};
  }
  return stoppedSession;
}

async function recordRuntimeStopFailure(sessionRef, session, dependencies, error) {
  try {
    await sessionRef.update(sessionStatusUpdate({...session, status: "stopping"}, "stop_failed", {
      lastError: error && error.publicMessage ? error.publicMessage : "session_stop_failed",
      updatedAt: dependencies.admin.firestore.Timestamp.now(),
    }, {reconciliationReason: "runtime_recreation_stop_failed"}));
  } catch (stateError) {
    logger.warn("Unable to record marked runtime stop failure", {
      sessionId: sessionRef.id,
      error: stateError.message || String(stateError),
    });
  }
}

function assertRuntimeRecreationAllowed(session) {
  const status = normalizeSessionState(session.status);
  if (status === "delete_failed") throw httpError(409, "session_delete_failed");
}

async function stopSession(uid, workspaceId, sessionId, dependencies = {}) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId, dependencies);
  const session = sessionSnap.data();
  assertMainSession(session);
  assertNoActiveResize(session);
  await sessionRef.update(sessionStatusUpdate(session, "stopping", {
    ...runtimeSessionStateUpdate(session, "stopping"),
    updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
  }));
  if (isChromeSession(session) && typeof dependencies.markChromeWorkspaceSessionStopping === "function") {
    await dependencies.markChromeWorkspaceSessionStopping(sessionRef, session);
  }
  const serviceDeleted = await dependencies.deleteSessionService(sessionRef, session, {reason: "manual"});
  if (!serviceDeleted) throw httpError(502, "session_stop_failed");
  return toClientDoc(await sessionRef.get());
}

async function deleteSession(uid, workspaceId, sessionId, dependencies = {}) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId, dependencies);
  const session = sessionSnap.data();
  assertMainSession(session);
  assertNoActiveResize(session);
  await sessionRef.update(sessionStatusUpdate(session, "deleting", {
    ...runtimeSessionStateUpdate(session, "stopping"),
    updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
  }));
  if (isChromeSession(session) && typeof dependencies.markChromeWorkspaceSessionStopping === "function") {
    await dependencies.markChromeWorkspaceSessionStopping(sessionRef, session);
  }
  const serviceDeleted = await dependencies.deleteSessionService(sessionRef, session, {reason: "deleted"});
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
    ...runtimeSessionStateUpdate(session, "stopped"),
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
          ...runtimeStateUpdate(workspaceSnap.data(), {...session, id: sessionRef.id}, "stopped", stoppedAt, {release: true}),
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
    if (isAutomationRuntime(session)) return {bypassed: true, bypassReason: "automation_runtime"};
    if (isMarkedRuntimeSession(session) && session.longRunning === true) {
      return {bypassed: true, bypassReason: "long_running"};
    }
    if (!isIdleSession(session, now)) return {idle: false};
    logger.info("stopping idle session", {
      workspaceId: session.workspaceId,
      sessionId: doc.id,
      serviceId: session.serviceId,
      managed: isMarkedRuntimeSession(session),
    });
    try {
      await doc.ref.update(sessionStatusUpdate(session, "stopping", {
        stopReason: "idle_timeout",
        updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
      }));
      const stopped = await dependencies.deleteSessionService(doc.ref, session, {reason: "idle_timeout"});
      return {
        eligible: true,
        stopped,
        failed: !stopped,
        reason: stopped ? "" : "deleteSessionService returned false",
      };
    } catch (error) {
      return {
        eligible: true,
        stopped: false,
        failed: true,
        reason: error,
      };
    }
  }));

  const values = results.map((result) => result.status === "fulfilled" ? result.value : {
    eligible: true,
    stopped: false,
    failed: true,
    reason: result.reason,
  });
  const bypassed = values.filter((value) => value.bypassed);
  const bypassedByReason = bypassed.reduce((counts, value) => {
    counts[value.bypassReason] = (counts[value.bypassReason] || 0) + 1;
    return counts;
  }, {});
  const eligible = values.filter((value) => value.eligible).length;
  const stopped = values.filter((value) => value.stopped === true).length;
  const failed = values.filter((value) => value.failed === true);
  failed.forEach((result) => logger.error("idle session stop failed", result.reason || "deleteSessionService returned false"));
  logger.info("idle session reap complete", {
    checked: snap.size,
    eligible,
    bypassed: bypassed.length,
    bypassedByReason,
    stopped,
    failed: failed.length,
  });
  return {
    checked: snap.size,
    eligible,
    bypassed: bypassed.length,
    bypassedByReason,
    stopped,
    failed: failed.length,
  };
}

function assertMainSession(session = {}) {
  if (isAutomationRuntime(session)) throw httpError(409, "automation_session_controlled");
}

async function assertNoActiveGithubWorkspaceSession(workspaceId, sessionId, session, dependencies) {
  await dependencies.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(dependencies.sessionCollection(workspaceId));
    const activeSession = snap.docs.find((doc) => {
      if (doc.id === sessionId) return false;
      const active = doc.data();
      return isActiveGithubWorkspaceSession(active);
    });
    if (activeSession) {
      throw httpError(409, "This GitHub workspace already has an active session. Stop it before restarting this one.");
    }
  });
}

function shouldRecreateSessionServiceOnRestart(session) {
  if (isMarkedRuntimeSession(session)) return true;
  if (isTerminalSessionStatus(session && session.status)) return true;
  if (cleanName(session && session.status) !== "update_failed") return false;
  if (!session.serviceUrl) return true;
  const lastError = String(session.lastError || "").toLowerCase();
  return lastError.includes("\"code\":404") || lastError.includes("does not exist") || lastError.includes("not found");
}

function assertSupportedSessionLaunch(session) {
  if (!isSupportedProvisioningSession(session)) throw httpError(409, "unsupported_runner");
}

function isGithubWorkspace(workspace) {
  return workspace && workspace.source && workspace.source.type === "github";
}

function authoritativeSessionSourceMetadata(workspace) {
  return {
    sourceMode: null,
    sourceVisibility: null,
    sourceRepoUrl: null,
    sourceRepoOwner: null,
    sourceRepoName: null,
    sourceRequestedBranch: null,
    sourceRequestedCommit: null,
    sourceResolvedBranch: null,
    sourceResolvedCommit: null,
    sourceInstallationId: null,
    sourceRepoId: null,
    ...sessionSourceMetadata(workspace),
  };
}

function isIdleSession(session, now) {
  const idleTimeoutMinutes = Math.min(
      positiveNumber(session.idleTimeoutMinutes, DEFAULT_IDLE_TIMEOUT_MINUTES),
      DEFAULT_IDLE_TIMEOUT_MINUTES,
  );
  const marked = isMarkedRuntimeSession(session);
  // Metadata writes and transport diagnostics are not work. Marked runners use
  // the activity signal exclusively, while old records retain the timestamp
  // fallback until they receive a runner revision that reports it.
  const idleSince = latestTimestampMillis(
      session.lastActivityAt,
      ...(marked ? [] : [session.updatedAt, session.createdAt]),
  );
  const runtimeStartedAt = latestTimestampMillis(session.runtimeStartedAt);
  const baseline = runtimeStartedAt && idleSince ? Math.max(runtimeStartedAt, idleSince) : runtimeStartedAt || idleSince;
  if (!baseline) return false;
  return now - baseline >= idleTimeoutMinutes * 60 * 1000;
}

module.exports = {createSessionLifecycleService, isIdleSession};
