"use strict";

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
  DEFAULT_FUNCTION_REGION,
  DEFAULT_IMAGE,
  GITHUB_APP_CLIENT_ID_SECRET,
  GITHUB_APP_CLIENT_SECRET_SECRET,
  GITHUB_APP_ID_SECRET,
  GITHUB_APP_PRIVATE_KEY_SECRET,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_ENCRYPTION_KEY,
  GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_OAUTH_STATE_SECRET,
  QA_LOGIN_SECRET,
  SESSION_BROWSER_ACCESS_TTL_MS,
} = require("./backendConfig");
const {
  cleanName,
  httpError,
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
const {createGithubService} = require("./github.service");
const {createGoogleWorkspaceConnectionsService} = require("./googleWorkspaceConnections.service");
const {createGoogleWorkspaceOAuthService, callbackPage} = require("./googleWorkspaceOAuth.service");
const {createGoogleOAuthStateService} = require("./googleWorkspaceOAuthState.service");
const {createGoogleWorkspaceApiService} = require("./googleWorkspaceApi.service");
const {createGoogleWorkspaceProvisioningService} = require("./googleWorkspaceProvisioning.service");
const {createGoogleMcpTokenBrokerService} = require("./googleMcpTokenBroker.service");
const {createGitSessionService} = require("./gitSession.service");
const {createAgentAuthService} = require("./agentAuth.service");
const {createEnvironmentKeysService} = require("./environmentKeys.service");
const {createOpenAiCodexAuthService} = require("./openAiCodexAuth.service");
const {createPiModelsService} = require("./piModels.service");
const {createPiPackagesService} = require("./piPackages.service");
const {createPreviewService} = require("./preview.service");
const {createQaAuthService} = require("./qaAuth.service");
const {createSessionCreationService} = require("./sessionCreation.service");
const {createSessionLifecycleService} = require("./sessionLifecycle.service");
const {createSshSessionService} = require("./sshSession.service");
const {createWorkspaceAgentAssetsService} = require("./workspaceAgentAssets.service");
const {
  classifyRunnerResponseError,
  parseRunnerResponseBody,
} = require("./runnerProxy.helpers");
const {createProvisioningWorker} = require("./provisioning.worker");
const {
  createRunnerImageFreshnessService,
  getSessionImageFreshness,
} = require("./runnerImageFreshness.service");
const {resolveSyncWriterLease} = require("./syncWriterLease.helpers");
const {createSyncWriterLeaseService} = require("./syncWriterLease.service");
const {
  isActiveGithubWorkspaceSession,
  isShellSession,
} = require("./sessionLifecycle.helpers");

const githubService = createGithubService();
const lifecycleDependencies = {admin, db, requireWorkspace, sessionCollection};
const sessionLifecycleService = createSessionLifecycleService(lifecycleDependencies);
const {
  deleteSession,
  markSessionStopped,
  reapIdleSessions,
  renameSession,
  requireSession,
  resizeSession,
  restartSession,
  stopSession,
} = sessionLifecycleService;
const agentAuthService = createAgentAuthService({
  admin,
  db,
  requestRunnerJson,
  requireSession,
  requireWorkspace,
});
const openAiCodexAuthService = createOpenAiCodexAuthService({agentAuthService});
const piPackagesService = createPiPackagesService({
  admin,
  db,
  requestRunnerJson,
  requireSession,
  requireWorkspace,
});
const piModelsService = createPiModelsService({
  admin,
  requestRunnerJson,
  requireSession,
  requireWorkspace,
});
const workspaceAgentAssetsService = createWorkspaceAgentAssetsService({
  requireSession,
  requireWorkspace,
  requestRunnerJson,
});
const environmentKeysService = createEnvironmentKeysService({admin, db});
const qaAuthService = createQaAuthService();
const googleWorkspaceConnectionsService = createGoogleWorkspaceConnectionsService({db});
const googleWorkspaceOAuthStateService = createGoogleOAuthStateService({
  db,
  secret: secretValue(GOOGLE_OAUTH_STATE_SECRET),
});
const googleWorkspaceOAuthService = createGoogleWorkspaceOAuthService({
  clientId: paramValue(GOOGLE_OAUTH_CLIENT_ID),
  clientSecret: secretValue(GOOGLE_OAUTH_CLIENT_SECRET),
  encryptionKey: secretValue(GOOGLE_OAUTH_ENCRYPTION_KEY),
  redirectUri: paramValue(GOOGLE_OAUTH_REDIRECT_URI),
  connectionsService: googleWorkspaceConnectionsService,
  requireWorkspace,
  stateService: googleWorkspaceOAuthStateService,
});
const googleWorkspaceProvisioningService = createGoogleWorkspaceProvisioningService({
  connectionsService: googleWorkspaceConnectionsService,
  oauthService: googleWorkspaceOAuthService,
  tokenRefreshUrl: googleMcpTokenRefreshUrl(),
});
const googleMcpTokenBrokerService = createGoogleMcpTokenBrokerService({
  connectionsService: googleWorkspaceConnectionsService,
  oauthService: googleWorkspaceOAuthService,
  sessionCollection,
});
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
  buildGenericEnvironmentEnv: (session, entryIds) =>
    environmentKeysService.resolveGenericEnvironment(session.ownerUid, entryIds),
  markSessionStopped,
  releaseChromeWorkspaceSession,
  getCurrentRunnerImageDigest: getCurrentRunnerImageDigestForSession,
  resolveGoogleMcpRuntime: (session) => googleWorkspaceProvisioningService.resolveGoogleMcpRuntime(
      session.ownerUid,
      session.workspaceId,
      session.mcpConfig,
  ),
  releaseWorkspaceSyncWriterLease,
});
const {
  deleteSessionService,
  patchSessionService,
  provisionSessionService,
} = cloudRunService;
Object.assign(lifecycleDependencies, {
  deleteSessionService,
  patchSessionService,
  prepareSessionForProvisioning,
  provisionSessionService,
  releaseChromeWorkspaceSession,
  releaseWorkspaceSyncWriterLease,
  reserveChromeWorkspaceSession,
  reserveWorkspaceSyncSession,
});
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
const googleWorkspaceApiService = createGoogleWorkspaceApiService({
  connectionsService: googleWorkspaceConnectionsService,
  db,
  oauthService: googleWorkspaceOAuthService,
  requireWorkspace,
});

function paramValue(param) {
  try {
    return param.value();
  } catch (error) {
    return "";
  }
}

function secretValue(secret) {
  try {
    return secret.value();
  } catch (error) {
    return "";
  }
}

function googleMcpTokenRefreshUrl() {
  const projectId = String(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) return "";
  return `https://${DEFAULT_FUNCTION_REGION}-${projectId}.cloudfunctions.net/googleMcpToken`;
}

const API_HANDLERS = createApiHandlers({
  agentAuthService,
  environmentKeysService,
  openAiCodexAuthService,
  piModelsService,
  piPackagesService,
  workspaceAgentAssetsService,
  workspaceService,
  githubService,
  googleWorkspaceService: googleWorkspaceApiService,
  operations: {
    userWithUsage,
    listAdminUsers,
    setAdminUserWhitelist,
    syncWorkspaceFiles,
    listSessions,
    createSession,
    renameSession,
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
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_STATE_SECRET,
    GOOGLE_OAUTH_ENCRYPTION_KEY,
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

    if (req.method === "GET" && route.name === "googleCallback") {
      try {
        const result = await googleWorkspaceApiService.completeGoogleConnection(req.query || {});
        res.status(result.status || 200).type("html").send(result.html);
      } catch (error) {
        logger.warn("Google OAuth callback failed", {error: error.publicMessage || error.message});
        res.status(error.status || 400).type("html").send(callbackPage(false, "Google connection could not be completed."));
      }
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

exports.googleMcpToken = onRequest({
  cors: false,
  timeoutSeconds: 30,
  secrets: [
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_ENCRYPTION_KEY,
  ],
}, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const result = await googleMcpTokenBrokerService.refreshAccessToken(req);
    res.status(200).json(result);
  } catch (error) {
    const status = error.status || 500;
    logger.warn("Google MCP access-token refresh failed", {
      status,
      error: error.publicMessage || "internal_error",
    });
    res.status(status).json({error: error.publicMessage || "internal_error"});
  }
});

exports.provisionQueuedSession = onDocumentWritten({
  document: "workspaces/{workspaceId}/sessions/{sessionId}",
  timeoutSeconds: 300,
  secrets: [
    GITHUB_APP_ID_SECRET,
    GITHUB_APP_PRIVATE_KEY_SECRET,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_STATE_SECRET,
    GOOGLE_OAUTH_ENCRYPTION_KEY,
  ],
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

exports.reapIdleSessions = onSchedule("every 5 minutes", reapIdleSessions);

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
  return db.runTransaction(async (transaction) => {
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
    return lease.sessionUpdates;
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
  return db.runTransaction(async (transaction) => {
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
    return lease.sessionUpdates;
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

function sessionCollection(workspaceId) {
  return db.collection("workspaces").doc(workspaceId).collection("sessions");
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
