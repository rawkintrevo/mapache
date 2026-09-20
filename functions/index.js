"use strict";

const {onRequest} = require("firebase-functions/v2/https");
const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const {
  admin,
  auth,
  db,
  storage,
} = require("./backendContext");
const {
  DEFAULT_BUCKET,
  DEFAULT_FUNCTION_REGION,
  AUTOMATION_AGENT_TOKEN_SECRET,
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
const {requireUser, updateUserTimezone} = require("./auth.service");
const {previewAutomationSchedule} = require("./automationSchedule.helpers");
const {createActiveInstancesService} = require("./activeInstances.service");
const {createAutomationAdmissionService} = require("./automationAdmission.service");
const {createAutomationCleanupService} = require("./automationCleanup.service");
const {createAutomationDefinitionsService} = require("./automationDefinitions.service");
const {createAutomationHistoryService} = require("./automationHistory.service");
const {createAutomationReconciliationService} = require("./automationReconciliation.service");
const {createAutomationRetryService} = require("./automationRetry.service");
const {
  AUTOMATION_PROVISIONING_TIMEOUT_MS,
  createAutomationProvisioningService,
} = require("./automationProvisioning.service");
const {createAutomationRunsService} = require("./automationRuns.service");
const {createAutomationSchedulerService} = require("./automationScheduler.service");
const {
  userWithUsage,
} = require("./userUsage.service");
const {
  createWorkspaceService,
  deleteWorkspaceStorageIfUnshared,
  requireWorkspace,
} = require("./workspace.service");
const {createWorkspaceAutomationDeletionService} = require("./workspaceAutomationDeletion.service");
const {createWorkspaceSharedStorageService} = require("./workspaceSharedStorage.service");
const {createWorkspaceStorageMigrationService} = require("./workspaceStorageMigration.service");
const {
  createCloudRunService,
  runnerServiceAccountValue,
} = require("./cloudRun.service");
const {
  SESSION_RESOURCE_ERROR_CODE,
  normalizeSessionResources,
} = require("./sessionResources.helpers");
const {createGithubService} = require("./github.service");
const {createGoogleWorkspaceConnectionsService} = require("./googleWorkspaceConnections.service");
const {createGoogleWorkspaceOAuthService, callbackPage} = require("./googleWorkspaceOAuth.service");
const {createGoogleOAuthStateService} = require("./googleWorkspaceOAuthState.service");
const {createGoogleWorkspaceApiService} = require("./googleWorkspaceApi.service");
const {createGoogleWorkspaceProvisioningService} = require("./googleWorkspaceProvisioning.service");
const {createGoogleMcpTokenBrokerService} = require("./googleMcpTokenBroker.service");
const {createGithubAutomationTokenBrokerService} = require("./githubAutomationTokenBroker.service");
const {createAutomationAgentAuthService} = require("./automationAgentAuth.service");
const {createAutomationAgentApiService} = require("./automationAgentApi.service");
const {createAgentAuthService} = require("./agentAuth.service");
const {createEnvironmentKeysService} = require("./environmentKeys.service");
const {createOpenAiCodexAuthService} = require("./openAiCodexAuth.service");
const {createPreviewService} = require("./preview.service");
const {createQaFaultHarnessService} = require("./qaFaultHarness.service");
const {createQaAuthService} = require("./qaAuth.service");
const {createSessionCreationService} = require("./sessionCreation.service");
const {createSessionLifecycleService} = require("./sessionLifecycle.service");
const {createSessionResizeService} = require("./sessionResize.service");
const {createSessionLogsService} = require("./sessionLogs.service");
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
const {isMainRuntime} = require("./runtimePaths.helpers");
const {createSyncWriterLeaseService} = require("./syncWriterLease.service");
const {createWorkspaceSessionReservationService} = require("./workspaceSessionReservation.service");
const {
  isActiveGithubWorkspaceSession,
} = require("./sessionLifecycle.helpers");

const automationAdmissionService = createAutomationAdmissionService({admin, db});
const activeInstancesService = createActiveInstancesService({db});
let automationRetryService;
const {
  assertMainAdmissionAllowed,
  wakeQueue: wakeAutomationQueue,
} = automationAdmissionService;
const {runTick: runAutomationScheduleTick} = createAutomationSchedulerService({
  admin,
  db,
  wakeQueue: wakeAutomationQueue,
});

const workspaceSessionReservationService = createWorkspaceSessionReservationService({admin, db});
const {
  markChromeWorkspaceSessionRunning,
  markChromeWorkspaceSessionStopping,
  releaseChromeWorkspaceSession,
  reserveChromeWorkspaceSession,
} = workspaceSessionReservationService;

function githubAutomationTokenRefreshUrl() {
  const projectId = String(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) return "";
  return `https://${DEFAULT_FUNCTION_REGION}-${projectId}.cloudfunctions.net/githubAutomationToken`;
}
const githubService = createGithubService({tokenRefreshUrl: githubAutomationTokenRefreshUrl()});
const githubAutomationTokenBrokerService = createGithubAutomationTokenBrokerService({
  db,
  githubClient: githubService.githubClient,
  githubConnection: githubService.githubConnection,
  sessionCollection,
});
const lifecycleDependencies = {
  admin,
  assertMainAdmissionAllowed,
  db,
  markChromeWorkspaceSessionStopping,
  normalizeRequestedSessionResources,
  requireWorkspace,
  sessionCollection,
  wakeAutomationQueue,
};
const sessionLifecycleService = createSessionLifecycleService(lifecycleDependencies);
const {
  deleteSession,
  markSessionStopped,
  reapIdleSessions,
  renameSession,
  requireSession,
  resizeSession: performSessionResize,
  restartSession,
  setSessionLongRunning,
  stopSession,
} = sessionLifecycleService;
const {enqueueResize: resizeSession, resizeQueuedSession} = createSessionResizeService({
  admin, db, requireSession, resizeSession: performSessionResize, normalizeRequestedSessionResources,
});
const sessionLogsService = createSessionLogsService({auth, requireSession});
const agentAuthService = createAgentAuthService({
  admin,
  db,
  githubClient: githubService.githubClient,
  requestRunnerJson,
  requireSession,
  requireWorkspace,
});
const openAiCodexAuthService = createOpenAiCodexAuthService({agentAuthService});
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
const qaFaultHarnessService = createQaFaultHarnessService({
  requestRunnerJson,
  requireSession,
});
const {
  createSessionAccessUrls,
  servePublicPreview,
  shareSessionPreview,
} = previewService;
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
  markChromeWorkspaceSessionRunning,
  releaseWorkspaceSyncWriterLease,
  automationOperationTimeoutMs: AUTOMATION_PROVISIONING_TIMEOUT_MS,
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
  markChromeWorkspaceSessionStopping,
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
const automationProvisioningService = createAutomationProvisioningService({
  admin,
  createSession,
  db,
  featureEnabled: async () => {
    const snap = await db.collection("appConfig").doc("automations").get();
    return Boolean(snap.exists && snap.data()?.enabled === true);
  },
  provisionSessionService,
  requireWorkspace,
  sessionCollection,
});
const {
  handleAutomationRunEvent,
  handleAutomationSessionEvent,
} = automationProvisioningService;

const automationCleanupService = createAutomationCleanupService({
  admin,
  db,
  deleteSessionService,
  releaseAutomationSlot: automationAdmissionService.releaseAutomationSlot,
  scheduleRetry: (...args) => automationRetryService?.scheduleRetry(...args),
  sessionCollection,
  wakeQueue: wakeAutomationQueue,
});
const {
  handleAutomationRunEvent: handleAutomationCleanupEvent,
} = automationCleanupService;
const automationReconciliationService = createAutomationReconciliationService({
  admin,
  auth,
  cleanupAutomationRun: automationCleanupService.cleanupAutomationRun,
  db,
  featureEnabled: async () => {
    const snap = await db.collection("appConfig").doc("automations").get();
    return Boolean(snap.exists && snap.data()?.enabled === true);
  },
  provisionAutomationRun: automationProvisioningService.provisionAutomationRun,
  processDueRetries: (...args) => automationRetryService.processDueRetries(...args),
  requestRunnerJson,
  sessionCollection,
});

const workspaceSharedStorageService = createWorkspaceSharedStorageService({
  admin,
  auth,
  db,
  requireWorkspace,
  storage,
});
const workspaceStorageMigrationService = createWorkspaceStorageMigrationService({
  admin,
  db,
  requireWorkspace,
  sessionCollection,
  sharedStorageService: workspaceSharedStorageService,
  storage,
});
const workspaceAutomationDeletionService = createWorkspaceAutomationDeletionService({
  admin,
  automationCleanupService,
  db,
  deleteLegacyStorage: (uid, workspace, options) => deleteWorkspaceStorageIfUnshared(uid, workspace, {admin, db, ...options}),
  deleteSessionForWorkspace: sessionLifecycleService.deleteSessionForWorkspace,
  deleteSessionService,
  deleteWorkspaceSharedStorage: (...args) => workspaceSharedStorageService.deleteWorkspaceSharedStorage(...args),
  sessionCollection,
});
const workspaceService = createWorkspaceService({
  admin,
  db,
  deleteSessionService,
  deleteWorkspaceSharedStorage: (...args) => workspaceSharedStorageService.deleteWorkspaceSharedStorage(...args),
  workspaceAutomationDeletionService,
  isConnectedGithubSourcePayload: githubService.isConnectedGithubSourcePayload,
  normalizeConnectedGithubSourcePayload: githubService.normalizeConnectedGithubSourcePayload,
  workspaceStorageMigrationService,
});
const automationDefinitionsService = createAutomationDefinitionsService({
  admin,
  db,
  requireWorkspace,
  wakeAutomationQueue,
});
const automationRunsService = createAutomationRunsService({
  admin,
  db,
  requireWorkspace,
  wakeAutomationQueue,
});
automationRetryService = createAutomationRetryService({
  admin,
  db,
  enqueueRetryRun: automationRunsService.enqueueRun,
});
const automationHistoryService = createAutomationHistoryService({db, storage});
const automationAgentAuthService = createAutomationAgentAuthService({
  db,
  secret: () => secretValue(AUTOMATION_AGENT_TOKEN_SECRET),
  sessionCollection,
});
const automationAgentApiService = createAutomationAgentApiService({
  authService: automationAgentAuthService,
  cleanupService: automationCleanupService,
  db,
  definitionsService: automationDefinitionsService,
  historyService: automationHistoryService,
  previewAutomationSchedule,
  runsService: automationRunsService,
  sessionCollection,
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
  activeInstancesService,
  agentAuthService,
  automationCleanupService,
  automationDefinitionsService,
  automationHistoryService,
  automationRunsService,
  environmentKeysService,
  openAiCodexAuthService,
  qaFaultHarnessService,
  workspaceService,
  githubService,
  googleWorkspaceService: googleWorkspaceApiService,
  operations: {
    userWithUsage,
    updateUserTimezone,
    previewAutomationSchedule,
    listAdminUsers,
    setAdminUserWhitelist,
    listSessions,
    createSession,
    renameSession,
    resizeSession,
    restartSession,
    setSessionLongRunning,
    stopSession,
    deleteSession,
    createSessionAccessUrls,
    listSessionLogs: sessionLogsService.listSessionLogs,
    shareSessionPreview,
  },
});

// Keep migration-only programmatic operations available to checked-in
// migration scripts without advertising them as deployed Firebase functions.
// The property is intentionally non-enumerable so the Functions runtime does
// not treat it as a trigger export.
Object.defineProperty(module.exports, "__mapacheMigrationOperations", {
  configurable: false,
  enumerable: false,
  value: Object.freeze({
    prepareWorkspaceSharedStorage: workspaceSharedStorageService.prepareWorkspaceSharedStorage,
    prepareWorkspaceStorageMigration: workspaceStorageMigrationService.prepare,
    completeWorkspaceStorageMigration: workspaceStorageMigrationService.complete,
    restartSession,
  }),
  writable: false,
});

exports.api = onRequest({
  cors: true,
  timeoutSeconds: 540,
  secrets: [
    GITHUB_APP_ID_SECRET,
    GITHUB_APP_CLIENT_ID_SECRET,
    GITHUB_APP_CLIENT_SECRET_SECRET,
    GITHUB_APP_PRIVATE_KEY_SECRET,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_STATE_SECRET,
    GOOGLE_OAUTH_ENCRYPTION_KEY,
    AUTOMATION_AGENT_TOKEN_SECRET,
    QA_LOGIN_SECRET,
  ],
}, async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    const route = apiRouteRequest(req.path);

    if (route.name === "automationAgent" || route.name === "automationAgentSchedulePreview") {
      const result = await automationAgentApiService.handleRequest(req, route);
      res.status(result.status || 200).json(result.body);
      return;
    }

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
    const body = {error: error.publicMessage || "internal_error"};
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(String(error.pendingRunId || ""))) {
      body.pendingRunId = String(error.pendingRunId);
    }
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(String(error.runId || ""))) {
      body.runId = String(error.runId);
    }
    res.status(status).json(body);
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

exports.githubAutomationToken = onRequest({
  cors: false,
  timeoutSeconds: 30,
  secrets: [GITHUB_APP_ID_SECRET, GITHUB_APP_PRIVATE_KEY_SECRET],
}, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    res.status(200).json(await githubAutomationTokenBrokerService.refreshAccessToken(req));
  } catch (error) {
    const status = error.status || 500;
    logger.warn("GitHub automation-token refresh failed", {
      status,
      error: error.publicMessage || "internal_error",
    });
    res.status(status).json({error: error.publicMessage || "internal_error"});
  }
});

exports.automationAgentToken = onRequest({
  cors: false,
  timeoutSeconds: 30,
  secrets: [AUTOMATION_AGENT_TOKEN_SECRET],
}, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    res.status(200).json(await automationAgentAuthService.mintToken(req));
  } catch (error) {
    const status = error.status || 500;
    logger.warn("Automation agent token request failed", {
      status,
      error: error.publicMessage || "internal_error",
    });
    res.status(status).json({error: error.publicMessage || "internal_error"});
  }
});

exports.provisionQueuedSession = onDocumentWritten({
  document: "workspaces/{workspaceId}/sessions/{sessionId}",
  timeoutSeconds: 540,
  secrets: [
    GITHUB_APP_ID_SECRET,
    GITHUB_APP_PRIVATE_KEY_SECRET,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_STATE_SECRET,
    GOOGLE_OAUTH_ENCRYPTION_KEY,
  ],
}, provisionQueuedSession);

exports.provisionAutomationRun = onDocumentWritten({
  document: "automationRuns/{runId}",
  timeoutSeconds: 540,
  retry: true,
  secrets: [
    GITHUB_APP_ID_SECRET,
    GITHUB_APP_PRIVATE_KEY_SECRET,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_STATE_SECRET,
    GOOGLE_OAUTH_ENCRYPTION_KEY,
  ],
}, handleAutomationRunEvent);

exports.cleanupAutomationRun = onDocumentWritten({
  document: "automationRuns/{runId}",
  timeoutSeconds: 540,
  retry: true,
  secrets: [
    GITHUB_APP_ID_SECRET,
    GITHUB_APP_PRIVATE_KEY_SECRET,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_STATE_SECRET,
    GOOGLE_OAUTH_ENCRYPTION_KEY,
  ],
}, handleAutomationCleanupEvent);

exports.reconcileAutomationSessionProvisioning = onDocumentWritten({
  document: "workspaces/{workspaceId}/sessions/{sessionId}",
  timeoutSeconds: 540,
  retry: true,
  secrets: [
    GITHUB_APP_ID_SECRET,
    GITHUB_APP_PRIVATE_KEY_SECRET,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_STATE_SECRET,
    GOOGLE_OAUTH_ENCRYPTION_KEY,
  ],
}, handleAutomationSessionEvent);

exports.dispatchAutomationSchedules = onSchedule("every 1 minutes", async (event) => {
  const result = await runAutomationScheduleTick(event);
  logger.info("automation schedule tick complete", result);
  return result;
});

exports.reconcileAutomationRuns = onSchedule("every 1 minutes", async () => {
  const result = await automationReconciliationService.reconcile();
  logger.info("automation reconciliation complete", result);
  return result;
});

exports.resizeQueuedSession = onDocumentWritten({
  document: "workspaces/{workspaceId}/sessions/{sessionId}",
  timeoutSeconds: 540,
  retry: true,
  secrets: [
    GITHUB_APP_ID_SECRET,
    GITHUB_APP_PRIVATE_KEY_SECRET,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_STATE_SECRET,
    GOOGLE_OAUTH_ENCRYPTION_KEY,
  ],
}, resizeQueuedSession);

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
  return Promise.all(snap.docs.filter((doc) => isMainRuntime(doc.data() || {})).map(async (doc) => {
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
      const resolved = resolveRunnerImage({imageKey: session.imageKey});
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

async function prepareSessionForProvisioning(session = {}) {
  return session;
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
      return isActiveGithubWorkspaceSession(active);
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

async function assertNoActiveGithubWorkspaceSession(workspaceId, sessionId, session) {
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(sessionCollection(workspaceId));
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
