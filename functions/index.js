"use strict";

const crypto = require("crypto");
const {onRequest} = require("firebase-functions/v2/https");
const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const {
  admin,
  db,
  storage,
} = require("./backendContext");
const {
  DEFAULT_BUCKET,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_IMAGE,
  DEFAULT_REGION,
  GITHUB_APP_CLIENT_ID_SECRET,
  GITHUB_APP_CLIENT_SECRET_SECRET,
  GITHUB_APP_ID_SECRET,
  GITHUB_APP_PRIVATE_KEY_SECRET,
  QA_LOGIN_SECRET,
  SESSION_BROWSER_ACCESS_TTL_MS,
} = require("./backendConfig");
const {
  cleanName,
  cloudRunServiceName,
  httpError,
  latestTimestampMillis,
  positiveNumber,
  toClientDoc,
} = require("./backendUtils.helpers");
const {resolveHarness} = require("./runnerCatalog.helpers");
const {resolveRunnerImage} = require("./runnerImages.helpers");
const {routeRequest: apiRouteRequest} = require("./apiRoutes.helpers");
const {dispatchApiRoute} = require("./apiDispatch.helpers");
const {createApiHandlers} = require("./apiHandlers.helpers");
const {
  listAdminUsers,
  setAdminUserWhitelist,
} = require("./admin.service");
const {requireUser} = require("./auth.service");
const {
  accrueSessionUsage,
  isTerminalSessionStatus,
  sessionUsageRecord,
  userWithUsage,
} = require("./userUsage.service");
const {
  createWorkspaceService,
  requireWorkspace,
} = require("./workspace.service");
const {
  createCloudRunService,
  runnerServiceAccountValue,
} = require("./cloudRun.service");
const {
  SESSION_RESOURCE_ERROR_CODE,
  normalizeSessionResources,
} = require("./sessionResources.helpers");
const {
  findActiveChromeSession,
  isChromeSession,
} = require("./chromeReservation.helpers");
const {mcpConfigForRunner} = require("./mcpConfig.helpers");
const {createGithubService} = require("./github.service");
const {createGitSessionService} = require("./gitSession.service");
const {createPiService} = require("./pi.service");
const {createPreviewService} = require("./preview.service");
const {createQaAuthService} = require("./qaAuth.service");
const {createSessionCreationService} = require("./sessionCreation.service");
const {createSshSessionService} = require("./sshSession.service");
const {
  classifyRunnerResponseError,
  parseRunnerResponseBody,
} = require("./runnerProxy.helpers");
const {sessionStatusUpdate} = require("./sessionLifecycle.helpers");
const {createProvisioningWorker} = require("./provisioning.worker");
const {
  createRunnerImageFreshnessService,
  getSessionImageFreshness,
} = require("./runnerImageFreshness.service");
const {resolveSyncWriterLease} = require("./syncWriterLease.helpers");
const {createSyncWriterLeaseService} = require("./syncWriterLease.service");
const {
  initialProvisioningMetadata,
} = require("./provisioning.helpers");

const githubService = createGithubService();
const piService = createPiService({
  requireSession,
  requireWorkspace,
  requestRunnerJson,
});
const qaAuthService = createQaAuthService();
const previewService = createPreviewService({
  admin,
  browserAccessTtlMs: SESSION_BROWSER_ACCESS_TTL_MS,
  db,
  defaultBucket: DEFAULT_BUCKET,
  requestRunnerJson,
  requireSession,
  storage,
});
const {
  createSessionAccessUrls,
  servePublicPreview,
  shareSessionPreview,
} = previewService;
const sshSessionService = createSshSessionService({requestRunnerJson, requireSession});
const {
  closeSshSessionForward,
  createSshSessionForward,
  listSshSessionFiles,
  listSshSessionForwards,
  readSshSessionFile,
  saveSshSessionFile,
} = sshSessionService;
const gitSessionService = createGitSessionService({
  githubService,
  requestRunnerJson,
  requireSession,
  requireWorkspace,
});
const {
  commitGit,
  getGitStatusSummary,
  openPullRequest,
  pullGit,
  pushGit,
  stageGit,
  unstageGit,
} = gitSessionService;
const sessionCreationService = createSessionCreationService({
  admin,
  db,
  normalizeRequestedSessionResources,
  releaseChromeWorkspaceSession,
  reserveChromeWorkspaceSession,
  reserveGithubWorkspaceSession,
  reserveWorkspaceSyncSession,
  resolveHarness,
  resolveRunnerImage,
  requireWorkspace,
  runnerServiceAccountValue,
  sessionCollection,
});
const {createSession} = sessionCreationService;
const runnerImageFreshnessService = createRunnerImageFreshnessService();
const {getCurrentRunnerImageDigest} = runnerImageFreshnessService;
const getCurrentRunnerImageDigestForSession = (session) =>
  getCurrentRunnerImageDigest(currentRunnerImageReference(session));
const syncWriterLeaseService = createSyncWriterLeaseService({db});
const {
  reconcileWorkspaceSyncWriterLease,
  releaseWorkspaceSyncWriterLease,
} = syncWriterLeaseService;
const cloudRunService = createCloudRunService({
  buildGithubAuthEnv: githubService.buildGithubAuthEnv,
  buildGenericEnvironmentEnv: (session, entryIds) => piService.resolveGenericEnvironment(session.ownerUid, entryIds),
  markSessionStopped,
  releaseChromeWorkspaceSession,
  getCurrentRunnerImageDigest: getCurrentRunnerImageDigestForSession,
  releaseWorkspaceSyncWriterLease,
});
const {
  deleteSessionService,
  patchSessionService,
  provisionSessionService,
} = cloudRunService;
const {provisionQueuedSession} = createProvisioningWorker({
  db,
  prepareProvisioningSession: prepareSessionForProvisioning,
  provisionSessionService,
  requireWorkspace,
  releaseChromeWorkspaceSession,
  releaseWorkspaceSyncWriterLease,
});

const workspaceService = createWorkspaceService({
  deleteSessionService,
  isConnectedGithubSourcePayload: githubService.isConnectedGithubSourcePayload,
  normalizeConnectedGithubSourcePayload: githubService.normalizeConnectedGithubSourcePayload,
});

const API_HANDLERS = createApiHandlers({
  piService,
  workspaceService,
  githubService,
  operations: {
    userWithUsage,
    listAdminUsers,
    setAdminUserWhitelist,
    syncWorkspaceFiles,
    listSessions,
    createSession,
    resizeSession,
    restartSession,
    stopSession,
    deleteSession,
    createSessionAccessUrls,
    shareSessionPreview,
    listSshSessionFiles,
    readSshSessionFile,
    saveSshSessionFile,
    listSshSessionForwards,
    createSshSessionForward,
    closeSshSessionForward,
    getGitStatusSummary,
    pullGit,
    stageGit,
    unstageGit,
    commitGit,
    pushGit,
    openPullRequest,
  },
});

exports.api = onRequest({
  cors: true,
  timeoutSeconds: 300,
  secrets: [
    GITHUB_APP_ID_SECRET,
    GITHUB_APP_CLIENT_ID_SECRET,
    GITHUB_APP_CLIENT_SECRET_SECRET,
    GITHUB_APP_PRIVATE_KEY_SECRET,
    QA_LOGIN_SECRET,
  ],
}, async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    const route = apiRouteRequest(req.path);

    if (req.method === "GET" && route.name === "githubCallback") {
      await githubService.handleGithubCallback(req, res);
      return;
    }

    if (req.method === "POST" && route.name === "qaCustomToken") {
      res.status(200).json(await qaAuthService.mintQaCustomToken(req));
      return;
    }

    if (req.method === "GET" && route.name === "publicPreview") {
      await servePublicPreview(route, req, res);
      return;
    }

    const user = await requireUser(req);

    await dispatchApiRoute({route, req, res, user, handlers: API_HANDLERS});
  } catch (error) {
    logger.error("api request failed", error);
    const status = error.status || 500;
    res.status(status).json({error: error.publicMessage || "internal_error"});
  }
});

exports.provisionQueuedSession = onDocumentWritten({
  document: "workspaces/{workspaceId}/sessions/{sessionId}",
  timeoutSeconds: 300,
}, provisionQueuedSession);

exports.reconcileWorkspaceSyncWriters = onSchedule("every 5 minutes", async () => {
  const workspaceSnap = await db.collection("workspaces").get();
  const results = await Promise.allSettled(workspaceSnap.docs.map((workspaceDoc) =>
    reconcileWorkspaceSyncWriterLease(workspaceDoc.id),
  ));
  const failed = results.filter((result) => result.status === "rejected");
  failed.forEach((result) => logger.error("workspace sync-writer reconciliation failed", result.reason));
  logger.info("workspace sync-writer reconciliation complete", {
    checked: workspaceSnap.size,
    failed: failed.length,
  });
});

exports.refreshRunnerImageFreshness = onSchedule("every 5 minutes", async () => {
  const snap = await db.collectionGroup("sessions")
      .where("status", "==", "running")
      .get();
  const results = await Promise.allSettled(snap.docs.map(async (doc) => {
    const session = {id: doc.id, ...doc.data()};
    const currentDigest = await getCurrentRunnerImageDigestForSession(session);
    const freshness = getSessionImageFreshness(session, currentDigest);
    const currentValue = currentDigest || null;
    if (session.runnerImageCurrentDigest === currentValue && session.runnerImageFreshness === freshness) return false;
    await doc.ref.update({
      runnerImageCurrentDigest: currentValue,
      runnerImageFreshness: freshness,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  }));
  const updated = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const failed = results.filter((result) => result.status === "rejected");
  failed.forEach((result) => logger.error("runner image freshness refresh failed", result.reason));
  logger.info("runner image freshness refresh complete", {
    checked: snap.size,
    updated,
    failed: failed.length,
  });
});

exports.reapIdleSessions = onSchedule("every 5 minutes", async () => {
  const snap = await db.collectionGroup("sessions")
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
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
    await deleteSessionService(doc.ref, session, {reason: "idle_timeout"});
    return true;
  }));

  const stopped = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const failed = results.filter((result) => result.status === "rejected");
  failed.forEach((result) => logger.error("idle session stop failed", result.reason));
  logger.info("idle session reap complete", {checked: snap.size, stopped, failed: failed.length});
});

async function listSessions(uid, workspaceId) {
  await requireWorkspace(uid, workspaceId);
  const snap = await sessionCollection(workspaceId)
      .orderBy("updatedAt", "desc")
      .get();
  return Promise.all(snap.docs.map(async (doc) => {
    const session = toClientDoc(doc);
    const currentDigest = await getCurrentRunnerImageDigestForSession(session);
    return {
      ...session,
      runnerImageCurrentDigest: currentDigest || session.runnerImageCurrentDigest || null,
      runnerImageFreshness: getSessionImageFreshness(session, currentDigest),
    };
  }));
}

function currentRunnerImageReference(session = {}) {
  try {
    if (session.imageKey) {
      const resolved = resolveRunnerImage({imageKey: session.imageKey}, DEFAULT_IMAGE);
      if (resolved.image) return resolved.image;
    }
  } catch (error) {
    logger.warn("current runner image catalog lookup failed", {
      imageKey: session.imageKey,
      error: error.message || String(error),
    });
  }
  return session.image || "";
}

async function syncWorkspaceFiles(uid, workspaceId) {
  await requireWorkspace(uid, workspaceId);
  const snap = await sessionCollection(workspaceId)
      .where("status", "==", "running")
      .get();
  const cloudSessions = snap.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .filter((session) => session.ownerUid === uid && session.serviceUrl && session.sessionType !== "ssh");

  const results = await Promise.all(cloudSessions.map(async (session) => {
    try {
      await requestRunnerWorkspaceSyncDown(session);
      return {sessionId: session.id, ok: true};
    } catch (error) {
      logger.warn("runner workspace sync down failed", {
        workspaceId,
        sessionId: session.id,
        error: error.publicMessage || error.message,
      });
      return {sessionId: session.id, ok: false, error: error.publicMessage || "runner_workspace_sync_down_failed"};
    }
  }));

  return {
    ok: true,
    sessionCount: cloudSessions.length,
    syncedCount: results.filter((result) => result.ok).length,
    failedCount: results.filter((result) => !result.ok).length,
    results,
  };
}

async function prepareSessionForProvisioning(session = {}) {
  if (session.sessionType !== "ssh" && session.terminalKind !== "ssh") return session;
  const secretDocId = session.sshProvisioningSecretDocId || `sshWorkspace_${session.workspaceId}`;
  const privateSnap = await db.collection("users").doc(session.ownerUid).collection("private").doc(secretDocId).get();
  if (!privateSnap.exists) throw httpError(409, "ssh_workspace_auth_missing");
  const secrets = privateSnap.data() || {};
  return {
    ...session,
    sessionEnv: {
      ...(session.sessionEnv || {}),
      SSH_AUTH_MODE: secrets.authMode || session.sessionEnv?.SSH_AUTH_MODE || "private-key",
      SSH_PRIVATE_KEY: secrets.privateKey || "",
      SSH_CERTIFICATE: secrets.certificate || "",
      SSH_KNOWN_HOSTS: secrets.knownHosts || "",
    },
  };
}

async function reserveWorkspaceSyncSession(workspaceId, sessionRef, session, options = {}) {
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  await db.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    const sessionsSnap = await transaction.get(sessionCollection(workspaceId));
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
    const lease = resolveSyncWriterLease(
        workspaceSnap.data(),
        sessionsSnap.docs.map((doc) => ({id: doc.id, ref: doc.ref, ...doc.data()})),
        session,
        sessionRef.id,
        {
          eligible: options.syncWriterEligible,
          now: admin.firestore.FieldValue.serverTimestamp(),
        },
    );
    if (Object.keys(lease.workspaceUpdates).length) transaction.update(workspaceRef, lease.workspaceUpdates);
    if (options.create === false) {
      transaction.update(sessionRef, lease.sessionUpdates);
    } else {
      transaction.set(sessionRef, {...session, ...lease.sessionUpdates});
    }
  });
}

async function reserveGithubWorkspaceSession(workspaceId, sessionRef, session, options = {}) {
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  await db.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    const sessionsSnap = await transaction.get(sessionCollection(workspaceId));
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
    const activeSession = sessionsSnap.docs.find((doc) => {
      const active = doc.data();
      return isActiveGithubWorkspaceSession(active) && !isShellSession(active) && !isShellSession(session);
    });
    if (activeSession) {
      throw httpError(409, "This GitHub workspace already has an active session. Stop it before creating another one.");
    }
    const lease = resolveSyncWriterLease(
        workspaceSnap.data(),
        sessionsSnap.docs.map((doc) => ({id: doc.id, ref: doc.ref, ...doc.data()})),
        session,
        sessionRef.id,
        {
          eligible: options.syncWriterEligible,
          now: admin.firestore.FieldValue.serverTimestamp(),
        },
    );
    if (Object.keys(lease.workspaceUpdates).length) transaction.update(workspaceRef, lease.workspaceUpdates);
    transaction.set(sessionRef, {...session, ...lease.sessionUpdates});
  });
}

async function reserveChromeWorkspaceSession(workspaceId, sessionRef, session, options = {}) {
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  await db.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    const sessionsSnap = await transaction.get(sessionCollection(workspaceId));
    const activeChrome = findActiveChromeSession(sessionsSnap.docs, sessionRef.id);
    if (activeChrome) {
      throw httpError(409, "This workspace already has an active Chrome session. Stop it before creating another one.");
    }
    if (options.githubWorkspace) {
      const activeGithub = sessionsSnap.docs.find((doc) => {
        if (doc.id === sessionRef.id) return false;
        const active = doc.data();
        return isActiveGithubWorkspaceSession(active) && !isShellSession(active);
      });
      if (activeGithub) {
        throw httpError(409, "This GitHub workspace already has an active session. Stop it before creating another one.");
      }
    }
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
    const lease = resolveSyncWriterLease(
        workspaceSnap.data(),
        sessionsSnap.docs.map((doc) => ({id: doc.id, ref: doc.ref, ...doc.data()})),
        session,
        sessionRef.id,
        {
          eligible: options.syncWriterEligible,
          now: admin.firestore.FieldValue.serverTimestamp(),
        },
    );
    transaction.update(workspaceRef, {
      activeChromeSessionId: sessionRef.id,
      activeChromeSessionState: session.status || "provisioning",
      activeChromeSessionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...lease.workspaceUpdates,
    });
    if (options.create !== false) transaction.set(sessionRef, {...session, ...lease.sessionUpdates});
    else transaction.update(sessionRef, lease.sessionUpdates);
  });
}

async function assertNoActiveGithubWorkspaceSession(workspaceId, sessionId, session) {
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(sessionCollection(workspaceId));
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

function isGithubWorkspace(workspace) {
  return workspace && workspace.source && workspace.source.type === "github";
}

function isActiveGithubWorkspaceSession(session) {
  return !isTerminalSessionStatus(session && session.status);
}

function isShellSession(session) {
  return cleanName(session && session.terminalKind) === "shell";
}

function shouldRecreateSessionServiceOnRestart(session) {
  if (isTerminalSessionStatus(session && session.status)) return true;
  if (cleanName(session && session.status) !== "update_failed") return false;
  if (!session.serviceUrl) return true;

  const lastError = String(session.lastError || "").toLowerCase();
  return lastError.includes("\"code\":404") ||
    lastError.includes("does not exist") ||
    lastError.includes("not found");
}

async function resizeSession(uid, workspaceId, sessionId, payload) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const resources = normalizeRequestedSessionResources(payload, {defaultResources: null});
  const resizedAt = admin.firestore.Timestamp.now();
  await sessionRef.update(sessionStatusUpdate(sessionSnap.data(), "resizing", {
    ...accrueSessionUsage(sessionSnap.data(), resizedAt),
    resources,
    updatedAt: resizedAt,
  }));
  await patchSessionService(sessionRef, {...sessionSnap.data(), resources});
  return toClientDoc(await sessionRef.get());
}

function normalizeRequestedSessionResources(payload, options = {}) {
  try {
    return normalizeSessionResources(payload, options);
  } catch (error) {
    if (error && error.code === SESSION_RESOURCE_ERROR_CODE) {
      throw httpError(400, SESSION_RESOURCE_ERROR_CODE, error);
    }
    throw error;
  }
}

async function restartSession(uid, workspaceId, sessionId) {
  const workspace = await requireWorkspace(uid, workspaceId);
  const sessionRef = sessionCollection(workspaceId).doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw httpError(404, "session_not_found");
  const session = sessionSnap.data();
  if (session.ownerUid && session.ownerUid !== uid) throw httpError(403, "session_forbidden");

  const recreatingSessionService = shouldRecreateSessionServiceOnRestart(session);
  if (recreatingSessionService && isGithubWorkspace(workspace) && !isShellSession(session)) {
    await assertNoActiveGithubWorkspaceSession(workspaceId, sessionId, session);
  }
  if (recreatingSessionService && isChromeSession(session)) {
    await reserveChromeWorkspaceSession(workspaceId, sessionRef, session, {
      create: false,
      githubWorkspace: isGithubWorkspace(workspace),
      syncWriterEligible: true,
    });
  }

  const restartedAt = admin.firestore.Timestamp.now();
  const browserAccessTokenSecret = session.browserAccessTokenSecret || crypto.randomBytes(32).toString("hex");
  const restartNonce = Date.now().toString();
  const mcpConfig = mcpConfigForRunner(workspace);
  const restartUpdate = sessionStatusUpdate(session, recreatingSessionService ? "provisioning" : "restarting", {
    browserAccessTokenSecret,
    mcpConfig,
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

  const restartedSession = {
    ...session,
    ...restartUpdate,
    browserAccessTokenSecret,
    restartNonce,
    workspaceId,
    workspaceStorageBucket: session.workspaceStorageBucket || workspace.bucket || DEFAULT_BUCKET,
    workspaceStoragePrefix: session.workspaceStoragePrefix || workspace.storagePrefix,
    serviceId: session.serviceId || `session-${sessionId.toLowerCase()}`,
    serviceName: session.serviceName || cloudRunServiceName(session.region || DEFAULT_REGION, session.serviceId || `session-${sessionId.toLowerCase()}`),
  };

  if (recreatingSessionService && !isChromeSession(session)) {
    await reserveWorkspaceSyncSession(workspaceId, sessionRef, restartedSession, {
      create: false,
      syncWriterEligible: true,
    });
  }

  if (recreatingSessionService) {
    await provisionSessionService(
        workspace,
        sessionRef,
        await prepareSessionForProvisioning(restartedSession),
    );
  } else {
    await patchSessionService(sessionRef, restartedSession, {restart: true});
  }

  return toClientDoc(await sessionRef.get());
}

async function stopSession(uid, workspaceId, sessionId) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  await sessionRef.update(sessionStatusUpdate(sessionSnap.data(), "stopping", {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }));
  await deleteSessionService(sessionRef, sessionSnap.data(), {reason: "manual"});
  return toClientDoc(await sessionRef.get());
}

async function deleteSession(uid, workspaceId, sessionId) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  await sessionRef.update(sessionStatusUpdate(sessionSnap.data(), "deleting", {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }));
  const serviceDeleted = await deleteSessionService(sessionRef, sessionSnap.data(), {reason: "deleted"});
  if (!serviceDeleted) {
    throw httpError(502, "session_delete_failed");
  }
  await sessionRef.delete();
  return {ok: true};
}


async function requireSession(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const sessionRef = sessionCollection(workspaceId).doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw httpError(404, "session_not_found");
  const data = sessionSnap.data();
  if (data.ownerUid && data.ownerUid !== uid) throw httpError(403, "session_forbidden");
  return {sessionRef, sessionSnap};
}

function sessionCollection(workspaceId) {
  return db.collection("workspaces").doc(workspaceId).collection("sessions");
}

async function markSessionStopped(sessionRef, session, reason) {
  try {
    await releaseWorkspaceSyncWriterLease(sessionRef, session, reason);
  } catch (error) {
    logger.warn("Workspace sync-writer lease release failed while stopping session", {
      workspaceId: session.workspaceId,
      sessionId: sessionRef.id,
      reason: reason || "unspecified",
      error: error.message || String(error),
    });
  }
  const stoppedAt = admin.firestore.Timestamp.now();
  const usageRecord = sessionUsageRecord(sessionRef, session, stoppedAt);
  const stopped = sessionStatusUpdate(session, "stopped", {
    activeSocketCount: 0,
    serviceUrl: null,
    stoppedAt,
    lastError: null,
    updatedAt: stoppedAt,
  }, {reconciliationReason: reason || "service_deleted"});
  if (reason) stopped.stopReason = reason;
  if (reason === "idle_timeout") {
    stopped.autoStoppedAt = stoppedAt;
  }
  if (isChromeSession(session)) {
    await db.runTransaction(async (transaction) => {
      const workspaceRef = db.collection("workspaces").doc(session.workspaceId);
      const workspaceSnap = await transaction.get(workspaceRef);
      if (usageRecord) transaction.set(usageRecord.ref, usageRecord.data, {merge: true});
      transaction.update(sessionRef, stopped);
      if (workspaceSnap.exists && workspaceSnap.data().activeChromeSessionId === sessionRef.id) {
        transaction.update(workspaceRef, {
          activeChromeSessionId: admin.firestore.FieldValue.delete(),
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
    const batch = db.batch();
    batch.set(usageRecord.ref, usageRecord.data, {merge: true});
    batch.update(sessionRef, stopped);
    await batch.commit();
    return;
  }
  await sessionRef.update(stopped);
}

async function releaseChromeWorkspaceSession(sessionRef, session, reason) {
  if (!isChromeSession(session) || !session.workspaceId) return;
  const workspaceRef = db.collection("workspaces").doc(session.workspaceId);
  await db.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists || workspaceSnap.data().activeChromeSessionId !== sessionRef.id) return;
    transaction.update(workspaceRef, {
      activeChromeSessionId: admin.firestore.FieldValue.delete(),
      activeChromeSessionState: reason ? `released:${cleanName(reason)}` : "released",
      activeChromeSessionReleasedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
}

async function requestRunnerWorkspaceSyncDown(session) {
  return requestRunnerJson(session, "/workspace/sync-down", {
    method: "POST",
    unavailableError: "runner_workspace_sync_down_unavailable",
    failureError: "runner_workspace_sync_down_failed",
  });
}

async function requestRunnerJson(session, routePath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await fetch(`${session.serviceUrl.replace(/\/+$/, "")}${routePath}`, {
      method: options.method || "GET",
      headers: {
        "x-shutdown-token": session.shutdownToken,
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const rawBody = await response.text().catch(() => "");
    const data = parseRunnerResponseBody(rawBody);
    if (!response.ok) {
      if (response.status === 404 && options.notFoundError) {
        throw httpError(options.notFoundStatus || 503, options.notFoundError);
      }
      throw httpError(
          response.status === 404 ? 503 : response.status,
          classifyRunnerResponseError({
            status: response.status,
            data,
            rawBody,
            fallbackError: options.failureError || "runner_request_failed",
          }),
      );
    }
    return data;
  } catch (error) {
    if (error && error.status) throw error;
    throw httpError(503, options.unavailableError || "runner_request_unavailable", error);
  } finally {
    clearTimeout(timeout);
  }
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
