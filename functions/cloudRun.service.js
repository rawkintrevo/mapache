"use strict";

const logger = require("firebase-functions/logger");
const {
  admin,
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
  isGoogleNotFound,
  normalizeServiceAccountEmail,
  publicGoogleError,
} = require("./backendUtils.helpers");
const {envMapToCloudRunEnv} = require("./env.helpers");
const {runnerImageCapabilities} = require("./runnerImages.helpers");

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
  let client;
  const parent = `projects/${await getProjectId()}/locations/${session.region}`;
  const serviceName = `${parent}/services/${session.serviceId}`;
  try {
    client = await (dependencies.auth || auth).getClient();
    const url = `https://run.googleapis.com/v2/${parent}/services?serviceId=${session.serviceId}`;
    const body = await buildCloudRunService(workspace, session, dependencies);
    const response = await client.request({url, method: "POST", data: body});
    await waitForOperation(client, response.data, dependencies);
    await setPublicInvoker(client, serviceName);
    const service = await getCloudRunService(client, serviceName);
    await sessionRef.update({
      status: "running",
      serviceUrl: service.uri || null,
      lastError: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    let provisioningError = error;
    if (client && isCloudRunOperationTimeout(error)) {
      const service = await reconcileProvisioningTimeout(client, serviceName);
      if (service) {
        try {
          await setPublicInvoker(client, serviceName);
          await sessionRef.update({
            status: "running",
            serviceUrl: service.uri,
            lastError: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return;
        } catch (reconciliationError) {
          provisioningError = reconciliationError;
        }
      }
    }
    await sessionRef.update({
      status: "provision_failed",
      lastError: publicGoogleError(provisioningError),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
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

async function patchSessionService(sessionRef, session, options = {}, dependencies = {}) {
  if (!session.serviceName) {
    await sessionRef.update({
      status: "needs_service",
      lastError: "This session has no Cloud Run serviceName yet.",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }

  try {
    const client = await auth.getClient();
    const url = `https://run.googleapis.com/v2/${session.serviceName}`;
    const body = await buildCloudRunPatch(session, options, dependencies);
    const updateMask = options.restart ?
      "template.containers,template.serviceAccount" :
      "template.containers.resources.limits,template.serviceAccount";
    const response = await client.request({
      url: `${url}?updateMask=${encodeURIComponent(updateMask)}`,
      method: "PATCH",
      data: body,
    });
    await waitForOperation(client, response.data);
    const service = await getCloudRunService(client, session.serviceName);
    await sessionRef.update({
      status: "running",
      serviceUrl: service.uri || session.serviceUrl || null,
      lastError: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await sessionRef.update({
      status: "update_failed",
      lastError: publicGoogleError(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function deleteSessionService(sessionRef, session, options = {}, dependencies = {}) {
  if (!session.serviceName) {
    await markSessionStopped(dependencies, sessionRef, session, options.reason);
    return true;
  }

  try {
    await requestRunnerShutdown(session);
    const client = await auth.getClient();
    const url = `https://run.googleapis.com/v2/${session.serviceName}`;
    const response = await client.request({url, method: "DELETE"});
    await waitForOperation(client, response.data);
    await markSessionStopped(dependencies, sessionRef, session, options.reason);
    return true;
  } catch (error) {
    if (isGoogleNotFound(error)) {
      await markSessionStopped(dependencies, sessionRef, session, options.reason);
      return true;
    }

    await sessionRef.update({
      status: "stop_failed",
      lastError: publicGoogleError(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
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
        minInstanceCount: 0,
        maxInstanceCount: 1,
      },
      containers: [{
        image: session.image,
        ports: [{containerPort: 8080}],
        resources: {limits: resourceLimits(session.resources)},
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
      containers: [{
        image: session.image,
        resources: {limits: resourceLimits(session.resources)},
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
  const capabilities = session.capabilities || runnerImageCapabilities(session.image);
  const terminal = terminalCommandEnv(session);
  const terminalKind = cleanName(session.terminalKind || "pi") || "pi";
  const homeDir = cleanHomeDir(session.homeDir || "/root");
  const piAgentDir = `${homeDir}/.pi/agent`.replace(/\/+/g, "/");
  const codexHome = session.codexHomeDir || codexHomeDir(session.runnerSessionId || session.id || "");
  const env = [
    ...envMapToCloudRunEnv({
      ...(session.workspaceEnv || {}),
      ...(session.sessionEnv || {}),
    }),
    {name: "FIREBASE_PROJECT_ID", value: process.env.GCLOUD_PROJECT || ""},
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
    {name: "TERMINAL_COMMAND", value: terminal.command},
    {name: "TERMINAL_ARGS", value: JSON.stringify(terminal.args)},
    {name: "TERMINAL_KIND", value: terminalKind},
    {name: "SESSION_SHUTDOWN_TOKEN", value: session.shutdownToken || ""},
    {name: "SESSION_BROWSER_TOKEN_SECRET", value: session.browserAccessTokenSecret || ""},
    {name: "WORKSPACE_SOURCE_TYPE", value: cleanName(session.sourceType || "blank") || "blank"},
    {name: "WORKSPACE_SYNC_POLICY_MODE", value: cleanName(session.syncPolicyMode || "blank") || "blank"},
    {name: "WORKSPACE_SYNC_POLICY_EXCLUDE", value: stringifySyncPolicyExclude(session.syncPolicyExclude)},
    {name: "MCP_CONFIG", value: stringifyMcpConfig(session.mcpConfig)},
    {name: "RUNNER_CAPABILITIES", value: JSON.stringify(capabilities)},
    options.restartNonce ? {name: "RESTART_NONCE", value: options.restartNonce} : null,
  ];

  if (terminalKind === "codex") {
    env.push(
        {name: "CODEX_HOME", value: codexHome},
        {name: "CODEX_HOME_STORAGE_BUCKET", value: session.codexHomeStorageBucket || session.workspaceStorageBucket || DEFAULT_BUCKET || ""},
        {
          name: "CODEX_HOME_STORAGE_PREFIX",
          value: session.codexHomeStoragePrefix || codexHomeStoragePrefix(session.workspaceStoragePrefix, session.runnerSessionId || session.id || ""),
        },
    );
  }

  if (capabilities.preview) {
    env.push(
        {name: "PREVIEW_ENABLED", value: "true"},
        {name: "PREVIEW_BASE_PATH", value: "/preview"},
        {name: "PREVIEW_STATIC_ROOT", value: defaultPreviewStaticRoot(capabilities)},
        capabilities.n64 ? {name: "PREVIEW_N64_ROM_PATH", value: "/workspace/build/game.z64"} : null,
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

  if (session.SSH_TARGET_HOST) {
    env.push(
        {name: "SSH_TARGET_HOST", value: session.SSH_TARGET_HOST},
        {name: "SSH_TARGET_PORT", value: session.SSH_TARGET_PORT || "22"},
        {name: "SSH_TARGET_USERNAME", value: session.SSH_TARGET_USERNAME || ""},
        {name: "SSH_INITIAL_DIRECTORY", value: session.SSH_INITIAL_DIRECTORY || "~"},
        {name: "SSH_AUTH_MODE", value: session.SSH_AUTH_MODE || "private-key"},
        {name: "SSH_STRICT_HOST_KEY_CHECKING", value: session.SSH_STRICT_HOST_KEY_CHECKING || "false"},
        session.SSH_PRIVATE_KEY ? {name: "SSH_PRIVATE_KEY", value: session.SSH_PRIVATE_KEY} : null,
        session.SSH_CERTIFICATE ? {name: "SSH_CERTIFICATE", value: session.SSH_CERTIFICATE} : null,
        session.SSH_KNOWN_HOSTS ? {name: "SSH_KNOWN_HOSTS", value: session.SSH_KNOWN_HOSTS} : null,
    );
  }

  return env.filter(Boolean);
}

function terminalCommandEnv(session) {
  const terminalKind = cleanName(session && session.terminalKind);
  if (terminalKind === "shell") {
    return {command: "bash", args: ["-l"]};
  }
  if (terminalKind === "codex") {
    return {command: "codex", args: []};
  }
  if (terminalKind === "ssh") {
    return {command: "", args: []};
  }
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

function codexHomeDir(sessionId) {
  const cleanSessionId = cleanName(sessionId) || "session";
  return `/tmp/mapache-codex/${cleanSessionId}`;
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

function codexHomeStoragePrefix(workspaceStoragePrefix, sessionId) {
  const cleanPrefix = String(workspaceStoragePrefix || "").replace(/^\/+|\/+$/g, "");
  if (!cleanPrefix) return "";
  return `${cleanPrefix}/${INTERNAL_STORAGE_DIR}/codex-home`;
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

async function requestRunnerShutdown(session) {
  if (!session.serviceUrl || !session.shutdownToken) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS);
  try {
    const response = await fetch(`${session.serviceUrl.replace(/\/+$/, "")}/shutdown`, {
      method: "POST",
      headers: {"x-shutdown-token": session.shutdownToken},
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn("runner shutdown request failed", {
        serviceId: session.serviceId,
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn("runner shutdown request failed", {
      serviceId: session.serviceId,
      error: cleanName(error.message || error),
    });
  } finally {
    clearTimeout(timeout);
  }
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

async function getProjectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || await auth.getProjectId();
}

function normalizeResources(payload) {
  return {
    cpu: cleanName(payload.cpu || DEFAULT_CPU),
    memory: cleanName(payload.memory || DEFAULT_MEMORY),
  };
}

function resourceLimits(resources) {
  return {
    cpu: resources.cpu,
    memory: resources.memory,
  };
}

module.exports = {
  buildCloudRunPatch,
  buildCloudRunService,
  codexHomeDir,
  codexHomeStoragePrefix,
  createCloudRunService,
  homeStoragePrefix,
  normalizeResources,
  piSessionDir,
  piSessionStoragePrefix,
  requestRunnerShutdown,
  requireRunnerServiceAccount,
  resourceLimits,
  runnerServiceAccountValue,
  sessionRunnerEnv,
  stringifyMcpConfig,
  stringifySyncPolicyExclude,
  terminalCommandEnv,
  waitForOperation,
};
