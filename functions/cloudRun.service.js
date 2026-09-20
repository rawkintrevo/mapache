"use strict";

const logger = require("firebase-functions/logger");
const {
  admin,
  db,
  auth,
} = require("./backendContext");
const {
  DEFAULT_BUCKET,
  DEFAULT_CLOUD_RUN_OPERATION_TIMEOUT_MS,
  DEFAULT_CPU,
  DEFAULT_MEMORY,
  DEFAULT_REGION,
  DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS,
  INTERNAL_STORAGE_DIR,
  SESSION_RUNNER_SERVICE_ACCOUNT,
} = require("./backendConfig");
const {
  cleanName,
  defaultPreviewStaticRoot,
  httpError,
  isGoogleAlreadyExists,
  isGoogleNotFound,
  normalizeServiceAccountEmail,
  publicGoogleError,
} = require("./backendUtils.helpers");
const {envMapToCloudRunEnv} = require("./env.helpers");
const {normalizeSessionResources} = require("./sessionResources.helpers");
const {isSupportedProvisioningSession, resolveSessionCapabilities} = require("./runnerCatalog.helpers");
const {getSessionImageFreshness} = require("./runnerImageFreshness.service");
const {sessionStatusUpdate} = require("./sessionLifecycle.helpers");
const {isRetryableProvisioningError} = require("./provisioning.helpers");
const {agentRuntimeEnvironment} = require("./agentRuntime.helpers");
const {
  isMarkedRuntimeSession,
  runtimeSessionStateUpdate,
} = require("./runtimeReservation.helpers");
const {consumeQaFault} = require("./qaFaultHarness.helpers");

const INTERRUPTED_RUNTIME_WARNING = "runtime_interrupted_checkpoint_recovery_required";

function createCloudRunService(dependencies = {}) {
  return {
    deleteSessionService: (sessionRef, session, options = {}) =>
      deleteSessionService(sessionRef, session, options, dependencies),
    patchSessionService: (sessionRef, session, options = {}) =>
      patchSessionService(sessionRef, session, options, dependencies),
    provisionSessionService: (workspace, sessionRef, session) =>
      provisionSessionService(workspace, sessionRef, session, dependencies),
  };
}

async function provisionSessionService(workspace, sessionRef, session, dependencies = {}) {
  if (!isSupportedProvisioningSession(session)) {
    await sessionRef.update(sessionStatusUpdate(session, "provision_failed", {
      lastError: "unsupported_runner",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {reconciliationReason: "unsupported_runner"}));
    if (typeof dependencies.releaseChromeWorkspaceSession === "function") {
      await dependencies.releaseChromeWorkspaceSession(sessionRef, session, "provision_failed");
    }
    return;
  }
  let client;
  let claimedSession = session;
  let operationName = session.provisioningCloudRunOperationName || null;
  const parent = `projects/${await getProjectId()}/locations/${session.region}`;
  const serviceName = `${parent}/services/${session.serviceId}`;
  try {
    let claim;
    if (session.provisioningOperationId) {
      claim = await claimProvisioningAttempt(sessionRef, session, dependencies);
      if (["completed", "failed", "in_progress", "stale"].includes(claim.action)) return;
      claimedSession = claim.session;
      operationName = claim.operationName || operationName;
    }

    client = await (dependencies.auth || auth).getClient();
    if (claim && claim.action === "poll") {
      await waitForOperation(client, {name: operationName}, dependencies);
    } else {
      const url = `https://run.googleapis.com/v2/${parent}/services?serviceId=${claimedSession.serviceId}`;
      const body = await buildCloudRunService(workspace, claimedSession, dependencies);
      const response = await client.request({url, method: "POST", data: body});
      operationName = response.data && response.data.name || null;
      if (claimedSession.provisioningOperationId) {
        await sessionRef.update({
          provisioningCloudRunOperationName: operationName,
          provisioningState: "running",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      await waitForOperation(client, response.data, dependencies);
    }
    await setPublicInvoker(client, serviceName);
    const service = await getCloudRunService(client, serviceName);
    const runnerImageMetadata = await deployedRunnerImageMetadata(client, serviceName, claimedSession, service, dependencies);
    await sessionRef.update(sessionStatusUpdate(claimedSession, "running", {
      ...runtimeSessionStateUpdate(claimedSession, "running"),
      serviceUrl: service.uri || null,
      lastError: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...runnerImageMetadata,
      ...provisioningCompletionUpdates(claimedSession, operationName),
    }, {reconciliationReason: "cloud_run_ready"}));
    await markChromeWorkspaceSessionRunning(sessionRef, claimedSession, dependencies);
  } catch (error) {
    let provisioningError = error;
    if (client && isGoogleAlreadyExists(error)) {
      try {
        const service = await waitForCloudRunServiceReady(client, serviceName, dependencies);
        await setPublicInvoker(client, serviceName);
        const runnerImageMetadata = await deployedRunnerImageMetadata(client, serviceName, claimedSession, service, dependencies);
        await sessionRef.update(sessionStatusUpdate(claimedSession, "running", {
          ...runtimeSessionStateUpdate(claimedSession, "running"),
          serviceUrl: service.uri,
          lastError: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          ...runnerImageMetadata,
          ...provisioningCompletionUpdates(claimedSession, operationName),
        }, {reconciliationReason: "cloud_run_existing_service_reconciled"}));
        await markChromeWorkspaceSessionRunning(sessionRef, claimedSession, dependencies);
        return;
      } catch (reconciliationError) {
        provisioningError = reconciliationError;
      }
    }
    if (client && isCloudRunOperationTimeout(error)) {
      const service = await reconcileProvisioningTimeout(client, serviceName);
      if (service) {
        try {
          await setPublicInvoker(client, serviceName);
          const runnerImageMetadata = await deployedRunnerImageMetadata(client, serviceName, claimedSession, service, dependencies);
          await sessionRef.update(sessionStatusUpdate(claimedSession, "running", {
            ...runtimeSessionStateUpdate(claimedSession, "running"),
            serviceUrl: service.uri,
            lastError: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            ...runnerImageMetadata,
            ...provisioningCompletionUpdates(claimedSession, operationName),
          }, {reconciliationReason: "cloud_run_timeout_reconciled"}));
          await markChromeWorkspaceSessionRunning(sessionRef, claimedSession, dependencies);
          return;
        } catch (reconciliationError) {
          provisioningError = reconciliationError;
        }
      }
    }
    await sessionRef.update(sessionStatusUpdate(claimedSession, "provision_failed", {
      ...runtimeSessionStateUpdate(claimedSession, "failed"),
      lastError: publicGoogleError(provisioningError),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...provisioningFailureUpdates(claimedSession, operationName, provisioningError),
    }, {reconciliationReason: "cloud_run_provisioning_failed"}));
    if (typeof dependencies.releaseChromeWorkspaceSession === "function") {
      try {
        await dependencies.releaseChromeWorkspaceSession(sessionRef, claimedSession, "provision_failed");
      } catch (releaseError) {
        logger.warn("Chrome workspace reservation release failed", {
          serviceId: claimedSession.serviceId,
          error: publicGoogleError(releaseError),
        });
      }
    }
    if (typeof dependencies.releaseWorkspaceSyncWriterLease === "function") {
      try {
        await dependencies.releaseWorkspaceSyncWriterLease(sessionRef, claimedSession, "provision_failed");
      } catch (releaseError) {
        logger.warn("Workspace sync-writer lease release failed", {
          serviceId: claimedSession.serviceId,
          error: publicGoogleError(releaseError),
        });
      }
    }
  }
}

async function claimProvisioningAttempt(sessionRef, session, dependencies = {}) {
  const firestore = dependencies.db || db;

  const claim = async (transaction) => {
    const snapshot = transaction ? await transaction.get(sessionRef) : await sessionRef.get();
    if (!snapshot.exists) return {action: "stale", session};

    const latest = {...session, ...snapshot.data()};
    if (latest.provisioningOperationId && latest.provisioningOperationId !== session.provisioningOperationId) {
      return {action: "stale", session: latest};
    }

    const state = provisioningState(latest);
    if (state === "completed") return {action: "completed", session: latest};
    if (state === "failed" && !latest.provisioningRetryable) {
      return {action: "failed", session: latest};
    }
    if (state === "running") {
      if (latest.provisioningCloudRunOperationName) {
        return {
          action: "poll",
          operationName: latest.provisioningCloudRunOperationName,
          session: latest,
        };
      }
      return {action: "in_progress", session: latest};
    }

    const updates = {
      provisioningAttempt: Number(latest.provisioningAttempt || 0) + 1,
      provisioningState: "running",
      provisioningAttemptStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      provisioningAttemptCompletedAt: null,
      provisioningCloudRunOperationName: null,
      provisioningRetryable: false,
      provisioningLastError: null,
    };
    if (transaction) transaction.update(sessionRef, updates);
    else await sessionRef.update(updates);
    return {
      action: "start",
      operationName: null,
      session: {...latest, ...updates},
    };
  };

  if (firestore && typeof firestore.runTransaction === "function") {
    return firestore.runTransaction((transaction) => claim(transaction));
  }
  return claim();
}

function provisioningState(session = {}) {
  if (session.provisioningState === "completed") return "completed";
  if (session.status === "running" && session.serviceUrl) return "completed";
  if (session.provisioningState === "failed" || session.status === "provision_failed") return "failed";
  if (session.provisioningState === "running") return "running";
  return "pending";
}

function provisioningCompletionUpdates(session, operationName) {
  if (!session.provisioningOperationId) return {};
  return {
    provisioningState: "completed",
    provisioningCloudRunOperationName: operationName || session.provisioningCloudRunOperationName || null,
    provisioningAttemptCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    provisioningRetryable: false,
    provisioningLastError: null,
  };
}

function provisioningFailureUpdates(session, operationName, error) {
  if (!session.provisioningOperationId) return {};
  return {
    provisioningState: "failed",
    provisioningCloudRunOperationName: operationName || session.provisioningCloudRunOperationName || null,
    provisioningAttemptCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    provisioningRetryable: isRetryableProvisioningError(error),
    provisioningLastError: publicGoogleError(error),
  };
}

async function reconcileProvisioningTimeout(client, serviceName) {
  try {
    const service = await getCloudRunService(client, serviceName);
    if (isCloudRunServiceReady(service)) return service;
  } catch (error) {
    if (!isGoogleNotFound(error)) {
      logger.warn("Cloud Run provisioning reconciliation failed", publicGoogleError(error));
    }
  }

  try {
    await client.request({
      url: `https://run.googleapis.com/v2/${serviceName}`,
      method: "DELETE",
    });
  } catch (error) {
    if (!isGoogleNotFound(error)) {
      logger.error("Cloud Run timed-out service cleanup failed", publicGoogleError(error));
    }
  }
  return null;
}

function isCloudRunServiceReady(service) {
  return Boolean(
      service &&
      service.uri &&
      service.terminalCondition &&
      service.terminalCondition.state === "CONDITION_SUCCEEDED",
  );
}

async function waitForCloudRunServiceReady(client, serviceName, options = {}) {
  const timeoutMs = positiveOperationNumber(
      options.operationTimeoutMs,
      DEFAULT_CLOUD_RUN_OPERATION_TIMEOUT_MS,
  );
  const pollIntervalMs = positiveOperationNumber(options.operationPollIntervalMs, 2000);
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const service = await getCloudRunService(client, serviceName);
    if (isCloudRunServiceReady(service)) return service;
    if (service && service.terminalCondition && service.terminalCondition.state === "CONDITION_FAILED") {
      throw new Error(cleanName(service.terminalCondition.message || "Existing Cloud Run service failed to become ready."));
    }
    if (attempt + 1 < maxAttempts) await sleep(pollIntervalMs);
  }
  const error = new Error(`Existing Cloud Run service did not become ready after ${timeoutMs}ms.`);
  error.code = "cloud_run_existing_service_timeout";
  throw error;
}

async function patchSessionService(sessionRef, session, options = {}, dependencies = {}) {
  if (!session.serviceName) {
    await sessionRef.update(sessionStatusUpdate(session, "needs_service", {
      lastError: "This session has no Cloud Run serviceName yet.",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {reconciliationReason: "missing_cloud_run_service"}));
    return;
  }

  try {
    const client = await (dependencies.auth || auth).getClient();
    const url = `https://run.googleapis.com/v2/${session.serviceName}`;
    const body = await buildCloudRunPatch(session, options, dependencies);
    const updateMask = options.restart ?
      "template.containers,template.serviceAccount" :
      isMarkedRuntimeSession(session) ?
        "template.containers.resources,template.serviceAccount" :
        "template.containers.resources.limits,template.serviceAccount";
    const response = await client.request({
      url: `${url}?updateMask=${encodeURIComponent(updateMask)}`,
      method: "PATCH",
      data: body,
    });
    await waitForOperation(client, response.data, dependencies);
    const service = await getCloudRunService(client, session.serviceName);
    const runnerImageMetadata = await deployedRunnerImageMetadata(client, session.serviceName, session, service, dependencies);
    await sessionRef.update(sessionStatusUpdate(session, "running", {
      ...runtimeSessionStateUpdate(session, "running"),
      serviceUrl: service.uri || session.serviceUrl || null,
      lastError: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...runnerImageMetadata,
    }, {reconciliationReason: "cloud_run_ready"}));
    await markChromeWorkspaceSessionRunning(sessionRef, session, dependencies);
  } catch (error) {
    await sessionRef.update(sessionStatusUpdate(session, "update_failed", {
      lastError: publicGoogleError(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {reconciliationReason: "cloud_run_update_failed"}));
  }
}

async function markChromeWorkspaceSessionRunning(sessionRef, session, dependencies = {}) {
  if (typeof dependencies.markChromeWorkspaceSessionRunning !== "function") return;
  await dependencies.markChromeWorkspaceSessionRunning(sessionRef, session);
}

async function deleteSessionService(sessionRef, session, options = {}, dependencies = {}) {
  if (!session.serviceName) {
    await markSessionStopped(dependencies, sessionRef, session, options.reason);
    return true;
  }

  try {
    const shutdownResult = await requestRunnerShutdown(session, {
      requireAcknowledgement: false,
      timeoutMs: dependencies.shutdownTimeoutMs,
    });
    if (await consumeQaFault(sessionRef, session, "uncertain-replacement", {
      db: dependencies.db || db,
      workspace: {agentUiVersion: session.agentUiVersion},
    })) {
      const error = new Error("qa_injected_uncertain_replacement");
      error.code = "qa_injected_uncertain_replacement";
      throw error;
    }
    const client = await (dependencies.auth || auth).getClient();
    const url = `https://run.googleapis.com/v2/${session.serviceName}`;
    const response = await client.request({url, method: "DELETE"});
    await waitForOperation(client, response.data, dependencies);
    const deletionConfirmed = await waitForCloudRunServiceDeleted(client, session.serviceName, dependencies);
    await markSessionStopped(dependencies, sessionRef, session, options.reason);
    if (deletionConfirmed === "absent" && (options.recoveryWarning || !shutdownResult.ok)) {
      await recordInterruptedRuntimeWarning(sessionRef);
    }
    return true;
  } catch (error) {
    if (isGoogleNotFound(error)) {
      await markSessionStopped(dependencies, sessionRef, session, options.reason);
      if (options.recoveryWarning) {
        await recordInterruptedRuntimeWarning(sessionRef);
      }
      return true;
    }

    const failureState = options.reason === "manual" || options.reason === "idle_timeout" ? "stop_failed" : "delete_failed";
    await sessionRef.update(sessionStatusUpdate(session, failureState, {
      lastError: publicGoogleError(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {reconciliationReason: failureState === "stop_failed" ? "cloud_run_stop_failed" : "cloud_run_delete_failed"}));
    return false;
  }
}

async function markSessionStopped(dependencies, sessionRef, session, reason) {
  if (typeof dependencies.markSessionStopped !== "function") {
    throw new Error("Cloud Run deletion requires a markSessionStopped dependency.");
  }
  await dependencies.markSessionStopped(sessionRef, session, reason);
}

async function buildCloudRunService(workspace, session, dependencies = {}) {
  return {
    template: {
      serviceAccount: requireRunnerServiceAccount(session),
      scaling: {
        minInstanceCount: 1,
        maxInstanceCount: 1,
      },
      containers: [{
        image: session.image,
        ports: [{containerPort: 8080}],
        resources: runtimeResourceRequirements(session),
        env: [
          ...await sessionRunnerEnv({
            ...session,
            workspaceId: workspace.id,
            workspaceStorageBucket: workspace.bucket || DEFAULT_BUCKET,
            workspaceStoragePrefix: workspace.storagePrefix,
          }, {}, dependencies),
        ],
      }],
    },
  };
}

async function buildCloudRunPatch(session, options = {}, dependencies = {}) {
  return {
    template: {
      serviceAccount: requireRunnerServiceAccount(session),
      scaling: {
        minInstanceCount: 1,
        maxInstanceCount: 1,
      },
      containers: [{
        image: session.image,
        resources: runtimeResourceRequirements(session),
        env: options.restart ? await sessionRunnerEnv(session, {
          restartNonce: Date.now().toString(),
        }, dependencies) : undefined,
      }],
    },
  };
}

function runnerServiceAccountValue(options = {}) {
  const envValue = Object.prototype.hasOwnProperty.call(options, "envValue") ?
    options.envValue :
    process.env.SESSION_RUNNER_SERVICE_ACCOUNT;
  const paramValue = Object.prototype.hasOwnProperty.call(options, "paramValue") ?
    options.paramValue :
    SESSION_RUNNER_SERVICE_ACCOUNT.value();
  return normalizeServiceAccountEmail(envValue || paramValue || "");
}

function requireRunnerServiceAccount(session = {}, options = {}) {
  const serviceAccount = runnerServiceAccountValue(options) ||
    normalizeServiceAccountEmail(session.serviceAccount || "");
  if (!serviceAccount) {
    throw new Error("Set SESSION_RUNNER_SERVICE_ACCOUNT to a least-privilege Cloud Run runtime service account before provisioning sessions.");
  }
  return serviceAccount;
}

async function sessionRunnerEnv(session, options = {}, dependencies = {}) {
  const capabilities = resolveSessionCapabilities(session);
  const terminal = terminalCommandEnv(session);
  const terminalKind = "pi";
  const homeDir = cleanHomeDir(session.homeDir || "/root");
  const piAgentDir = `${homeDir}/.pi/agent`.replace(/\/+/g, "/");
  const environmentEntryIds = sessionEnvironmentEntryIds(session);
  const genericEnvironment = typeof dependencies.buildGenericEnvironmentEnv === "function" ?
    await dependencies.buildGenericEnvironmentEnv(session, environmentEntryIds) : {};
  const googleMcpRuntime = typeof dependencies.resolveGoogleMcpRuntime === "function" ?
    await dependencies.resolveGoogleMcpRuntime(session) : {mcpConfig: session.mcpConfig, env: {}};
  const env = [
    ...envMapToCloudRunEnv({
      ...(session.workspaceEnv || {}),
      ...(session.sessionEnv || {}),
      ...genericEnvironment,
    }),
    ...trustedRuntimeEnv(googleMcpRuntime.env),
    {name: "FIREBASE_PROJECT_ID", value: process.env.GCLOUD_PROJECT || ""},
    {name: "MAPACHE_RUNTIME_KIND", value: session.runtimeKind || "main"},
    {name: "MAPACHE_AUTOMATION_RUN_ID", value: session.automationRunId || ""},
    {name: "HOME", value: homeDir},
    {name: "MAPACHE_HOME_DIR", value: homeDir},
    {name: "OWNER_UID", value: session.ownerUid || ""},
    {name: "WORKSPACE_ID", value: session.workspaceId || ""},
    {name: "SESSION_ID", value: session.runnerSessionId || ""},
    {name: "STORAGE_BUCKET", value: session.workspaceStorageBucket || DEFAULT_BUCKET || ""},
    {name: "STORAGE_PREFIX", value: session.workspaceStoragePrefix || ""},
    {name: "HOME_STORAGE_BUCKET", value: session.homeStorageBucket || session.workspaceStorageBucket || DEFAULT_BUCKET || ""},
    {name: "HOME_STORAGE_PREFIX", value: session.homeStoragePrefix || homeStoragePrefix(session.workspaceStoragePrefix)},
    {name: "HOME_SYNC_MODE", value: cleanName(session.homeMode || "persistent") || "persistent"},
    {name: "HOME_ARCHIVE_NAME", value: cleanName(session.homeArchiveName || "home.tar.gz") || "home.tar.gz"},
    {name: "PI_SESSION_DIR", value: session.piSessionDir || piSessionDir(session.runnerSessionId || session.id || "", homeDir)},
    {name: "PI_SESSION_STORAGE_BUCKET", value: session.piSessionStorageBucket || session.workspaceStorageBucket || DEFAULT_BUCKET || ""},
    {
      name: "PI_SESSION_STORAGE_PREFIX",
      value: session.piSessionStoragePrefix || piSessionStoragePrefix(session.workspaceStoragePrefix, session.runnerSessionId || session.id || ""),
    },
    {name: "PI_SESSION_JSONL_PATH", value: session.piSessionJsonlPath || ""},
    {name: "PI_CODING_AGENT_DIR", value: piAgentDir},
    {name: "SESSION_NAME", value: cleanName(session.name || "Terminal session")},
    {name: "HARNESS_ID", value: "pi"},
    {name: "TERMINAL_COMMAND", value: terminal.command},
    {name: "TERMINAL_ARGS", value: JSON.stringify(terminal.args)},
    {name: "TERMINAL_KIND", value: terminalKind},
    {name: "SESSION_SHUTDOWN_TOKEN", value: session.shutdownToken || ""},
    {name: "SESSION_BROWSER_TOKEN_SECRET", value: session.browserAccessTokenSecret || ""},
    ...agentRuntimeEnvironment(session),
    {name: "WORKSPACE_SOURCE_TYPE", value: cleanName(session.sourceType || "blank") || "blank"},
    {name: "WORKSPACE_SYNC_ROLE", value: cleanName(session.syncWriterRole || "writer") || "writer"},
    {name: "WORKSPACE_SYNC_POLICY_MODE", value: cleanName(session.syncPolicyMode || "blank") || "blank"},
    {name: "WORKSPACE_SYNC_POLICY_EXCLUDE", value: stringifySyncPolicyExclude(session.syncPolicyExclude)},
    {name: "MCP_CONFIG", value: stringifyMcpConfig(googleMcpRuntime.mcpConfig || session.mcpConfig)},
    {name: "RUNNER_CAPABILITIES", value: JSON.stringify(capabilities)},
    options.restartNonce ? {name: "RESTART_NONCE", value: options.restartNonce} : null,
  ];

  if (capabilities.preview) {
    env.push(
        {name: "PREVIEW_ENABLED", value: "true"},
        {name: "PREVIEW_BASE_PATH", value: "/preview"},
        {name: "PREVIEW_STATIC_ROOT", value: defaultPreviewStaticRoot(capabilities)},
        {name: "PREVIEW_INJECT_LOGGER", value: "true"},
        {name: "PREVIEW_LOG_LIMIT", value: "500"},
        {name: "MAPACHE_RUNNER_URL", value: "http://127.0.0.1:8080"},
        {name: "MAPACHE_PREVIEW_URL", value: "http://127.0.0.1:8080/preview/"},
        {name: "MAPACHE_QA_DIR", value: "/workspace/.mapache/qa"},
    );
  }

  if (cleanName(session.sourceType) === "github") {
    env.push(
        {name: "GITHUB_REPO_URL", value: cleanName(session.sourceRepoUrl || "")},
        {name: "GITHUB_REPO_OWNER", value: cleanName(session.sourceRepoOwner || "")},
        {name: "GITHUB_REPO_NAME", value: cleanName(session.sourceRepoName || "")},
        {name: "GITHUB_REQUESTED_BRANCH", value: cleanName(session.sourceRequestedBranch || "")},
        {name: "GITHUB_REQUESTED_COMMIT", value: cleanName(session.sourceRequestedCommit || "")},
        {name: "GITHUB_RESOLVED_BRANCH", value: cleanName(session.sourceResolvedBranch || "")},
        {name: "GITHUB_RESOLVED_COMMIT", value: cleanName(session.sourceResolvedCommit || "")},
        {
          name: "GITHUB_CHECKOUT_REF",
          value: cleanName(
              session.sourceResolvedCommit ||
              session.sourceRequestedCommit ||
              session.sourceResolvedBranch ||
              session.sourceRequestedBranch ||
              "",
          ),
        },
    );

    if (typeof dependencies.buildGithubAuthEnv === "function") {
      env.push(...await dependencies.buildGithubAuthEnv(session));
    }
  }

  if (capabilities.chrome) {
    env.push(
        {name: "CHROME_PROFILE_DIR", value: "/var/lib/mapache/chrome/profile"},
        {name: "CHROME_CDP_HOST", value: "127.0.0.1"},
        {name: "CHROME_CDP_PORT", value: "9222"},
        {name: "CHROME_DISPLAY", value: ":99"},
        {name: "CHROME_NOVNC_PORT", value: "6080"},
        {name: "CHROME_VNC_HOST", value: "127.0.0.1"},
        {name: "CHROME_VNC_PORT", value: "5900"},
        {name: "MAPACHE_BROWSER_CDP_URL", value: "http://127.0.0.1:9222"},
        {name: "MAPACHE_BROWSER_STATUS_URL", value: "http://127.0.0.1:8080/browser/status"},
        {name: "MAPACHE_BROWSER_ACTIVITY_URL", value: "http://127.0.0.1:8080/browser/activity"},
    );
  }

  return env.filter(Boolean);
}

function trustedRuntimeEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([name, item]) => ({
    name,
    value: item == null ? "" : String(item),
  }));
}

function sessionEnvironmentEntryIds(session = {}) {
  const selected = Array.isArray(session.environmentEntryIds) ?
    session.environmentEntryIds :
    (Array.isArray(session.genericEnvironmentEntryIds) ? session.genericEnvironmentEntryIds : []);
  return [...new Set(selected.map((id) => String(id || "").trim()).filter(Boolean))];
}

function terminalCommandEnv(session) {
  const homeDir = cleanHomeDir(session && session.homeDir || "/root");
  return {
    command: "pi",
    args: ["--session-dir", session.piSessionDir || piSessionDir(session.runnerSessionId || session.id || "", homeDir), "-c"],
  };
}

function homeStoragePrefix(workspaceStoragePrefix) {
  const cleanPrefix = String(workspaceStoragePrefix || "").replace(/^\/+|\/+$/g, "");
  return cleanPrefix ? `${cleanPrefix}/${INTERNAL_STORAGE_DIR}/home` : "";
}

function piSessionDir(sessionId, homeDir = "/root") {
  const cleanSessionId = cleanName(sessionId);
  const cleanDir = cleanHomeDir(homeDir);
  return cleanSessionId ?
    `${cleanDir}/.pi/agent/mapache-sessions/${cleanSessionId}` :
    `${cleanDir}/.pi/agent/mapache-sessions/session`;
}

function cleanHomeDir(value) {
  const path = cleanName(value || "/root").replace(/\/+$/, "");
  return path && path.startsWith("/") ? path : "/root";
}

function piSessionStoragePrefix(workspaceStoragePrefix, sessionId) {
  const cleanPrefix = String(workspaceStoragePrefix || "").replace(/^\/+|\/+$/g, "");
  const cleanSessionId = cleanName(sessionId);
  if (!cleanPrefix || !cleanSessionId) return "";
  return `${cleanPrefix}/${INTERNAL_STORAGE_DIR}/sessions/${cleanSessionId}/pi-session`;
}

function stringifySyncPolicyExclude(value) {
  try {
    return JSON.stringify(Array.isArray(value) ? value : []);
  } catch (error) {
    return "[]";
  }
}

function stringifyMcpConfig(value) {
  try {
    const config = value && typeof value === "object" ? value : {};
    const servers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ?
      config.mcpServers :
      {};
    return JSON.stringify({version: 1, mcpServers: servers});
  } catch (error) {
    return JSON.stringify({version: 1, mcpServers: {}});
  }
}

async function requestRunnerShutdown(session, options = {}) {
  if (!session.serviceUrl || !session.shutdownToken) return {ok: true, skipped: true};

  const controller = new AbortController();
  const timeoutMs = positiveOperationNumber(options.timeoutMs, DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${session.serviceUrl.replace(/\/+$/, "")}/shutdown`, {
      method: "POST",
      headers: {"x-shutdown-token": session.shutdownToken},
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`runner_shutdown_http_${response.status || "failed"}`);
      error.code = "runner_shutdown_failed";
      throw error;
    }
    return {ok: true};
  } catch (error) {
    logger.warn("runner shutdown request failed", {
      serviceId: session.serviceId,
      error: cleanName(error.message || error),
    });
    if (options.requireAcknowledgement) {
      const failure = new Error("runner_shutdown_failed");
      failure.code = "runner_shutdown_failed";
      throw failure;
    }
    return {ok: false};
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForCloudRunServiceDeleted(client, serviceName, options = {}) {
  const timeoutMs = positiveOperationNumber(
      options.operationTimeoutMs,
      DEFAULT_CLOUD_RUN_OPERATION_TIMEOUT_MS,
  );
  const pollIntervalMs = positiveOperationNumber(options.operationPollIntervalMs, 2000);
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await getCloudRunService(client, serviceName);
    } catch (error) {
      if (isGoogleNotFound(error)) return "absent";
      throw error;
    }
    if (attempt + 1 < maxAttempts) await sleep(pollIntervalMs);
  }
  const error = new Error(`Cloud Run service deletion was not confirmed after ${timeoutMs}ms.`);
  error.code = "cloud_run_delete_confirmation_timeout";
  throw error;
}

async function recordInterruptedRuntimeWarning(sessionRef) {
  await sessionRef.update({
    agentRuntimeRecoveryWarning: "interrupted",
    agentRuntimeRecoveryWarningAt: admin.firestore.FieldValue.serverTimestamp(),
    lastError: INTERRUPTED_RUNTIME_WARNING,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function setPublicInvoker(client, serviceName) {
  const url = `https://run.googleapis.com/v2/${serviceName}:setIamPolicy`;
  await client.request({
    url,
    method: "POST",
    data: {
      policy: {
        bindings: [{
          role: "roles/run.invoker",
          members: ["allUsers"],
        }],
      },
    },
  });
}

async function waitForOperation(client, operation, options = {}) {
  if (!operation || !operation.name) return;
  const timeoutMs = positiveOperationNumber(
      options.operationTimeoutMs,
      DEFAULT_CLOUD_RUN_OPERATION_TIMEOUT_MS,
  );
  const pollIntervalMs = positiveOperationNumber(options.operationPollIntervalMs, 2000);
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const url = `https://run.googleapis.com/v2/${operation.name}`;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await client.request({url, method: "GET"});
    if (response.data && response.data.done) {
      if (response.data.error) {
        throw new Error(JSON.stringify(response.data.error));
      }
      return response.data;
    }
    if (attempt + 1 < maxAttempts) await sleep(pollIntervalMs);
  }
  const error = new Error(`Cloud Run operation timed out after ${timeoutMs}ms.`);
  error.code = "cloud_run_operation_timeout";
  throw error;
}

function positiveOperationNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isCloudRunOperationTimeout(error) {
  return Boolean(error && error.code === "cloud_run_operation_timeout");
}

async function getCloudRunService(client, serviceName) {
  const url = `https://run.googleapis.com/v2/${serviceName}`;
  const response = await client.request({url, method: "GET"});
  return response.data || {};
}

async function deployedRunnerImageMetadata(client, serviceName, session, service, dependencies = {}) {
  try {
    const revisionName = service.latestReadyRevision ||
      service.latestReadyRevisionName ||
      service.latestCreatedRevision ||
      service.latestCreatedRevisionName;
    if (!revisionName) return {};
    const fullRevisionName = revisionName.startsWith("projects/") ?
      revisionName : `${serviceName.slice(0, serviceName.lastIndexOf("/services/"))}/revisions/${revisionName}`;
    const response = await client.request({
      url: `https://run.googleapis.com/v2/${fullRevisionName}`,
      method: "GET",
    });
    const revision = response.data || {};
    const digest = revision.imageDigest ||
      revision.containers?.[0]?.imageDigest ||
      revision.template?.containers?.[0]?.imageDigest ||
      "";
    if (!digest) return {};
    let currentDigest = null;
    if (typeof dependencies.getCurrentRunnerImageDigest === "function") {
      currentDigest = await dependencies.getCurrentRunnerImageDigest(session);
    }
    return {
      runnerImageDigest: digest,
      runnerImageCurrentDigest: currentDigest || null,
      runnerImageFreshness: getSessionImageFreshness({
        ...session,
        status: "running",
        runnerImageDigest: digest,
      }, currentDigest),
    };
  } catch (error) {
    logger.warn("runner image deployment metadata lookup failed", {
      serviceId: session.serviceId,
      error: error.message || String(error),
    });
    return {};
  }
}

async function getProjectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || await auth.getProjectId();
}

function normalizeResources(payload) {
  return normalizeSessionResources(payload, {
    defaultResources: {cpu: DEFAULT_CPU, memory: DEFAULT_MEMORY},
  });
}

function resourceLimits(resources) {
  return {
    cpu: resources.cpu,
    memory: resources.memory,
  };
}

function runtimeResourceRequirements(session = {}) {
  const resources = {limits: resourceLimits(session.resources)};
  if (isMarkedRuntimeSession(session)) resources.cpuIdle = false;
  return resources;
}

module.exports = {
  buildCloudRunPatch,
  buildCloudRunService,
  createCloudRunService,
  homeStoragePrefix,
  normalizeResources,
  piSessionDir,
  piSessionStoragePrefix,
  requestRunnerShutdown,
  requireRunnerServiceAccount,
  resourceLimits,
  runtimeResourceRequirements,
  runnerServiceAccountValue,
  sessionEnvironmentEntryIds,
  sessionRunnerEnv,
  stringifyMcpConfig,
  stringifySyncPolicyExclude,
  terminalCommandEnv,
  waitForOperation,
  waitForCloudRunServiceDeleted,
};
