"use strict";

const crypto = require("crypto");
const {
  DEFAULT_BUCKET,
  DEFAULT_CPU,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_MEMORY,
  DEFAULT_REGION,
} = require("./backendConfig");
const {
  cleanName,
  cloudRunServiceName,
  httpError,
  positiveNumber,
  toClientDoc,
  userPath,
} = require("./backendUtils.helpers");
const {resolveHarness} = require("./runnerCatalog.helpers");
const {
  homeStoragePrefix,
  piSessionDir,
  piSessionStoragePrefix,
  runnerServiceAccountValue,
} = require("./cloudRun.service");
const {mcpConfigForRunner} = require("./mcpConfig.helpers");
const {sessionSourceMetadata} = require("./github.service");
const {normalizeEnvMap} = require("./env.helpers");
const {
  automationSessionId,
  canonicalizeInternalStoragePath,
  isAutomationRuntime,
  normalizeRuntimeKind,
} = require("./runtimePaths.helpers");
const {
  AGENT_IMAGE_KEY,
  isMarkedAgentWorkspace,
  markedAgentSessionMetadata,
} = require("./agentRuntime.helpers");
const {
  initialProvisioningMetadata,
  normalizeProvisioningOperationId,
  provisioningSessionId,
  resolveCloudRunServiceId,
} = require("./provisioning.helpers");

function createSessionCreationService(dependencies = {}) {
  return {
    createSession: (uid, workspaceId, payload) => createSession(uid, workspaceId, payload, dependencies),
  };
}

async function createSession(uid, workspaceId, payload, dependencies = {}) {
  payload = payload || {};
  const workspace = await dependencies.requireWorkspace(uid, workspaceId);
  const runtimeKind = normalizeRuntimeKind(payload.runtimeKind);
  const automationRunId = runtimeKind === "automation" ? cleanName(payload.automationRunId || payload.runId) : "";
  if (runtimeKind === "automation" && !automationRunId) throw httpError(400, "invalid_automation_run_id");
  let runtimeSessionId = "";
  if (runtimeKind === "automation") {
    try {
      runtimeSessionId = automationSessionId(automationRunId);
    } catch (error) {
      throw httpError(400, error.code || "invalid_automation_run_id", error);
    }
  }
  let provisioningOperationId;
  try {
    provisioningOperationId = normalizeProvisioningOperationId(
        payload.operationId || payload.provisioningOperationId || payload.idempotencyKey || automationRunId,
    );
  } catch (error) {
    if (error && error.code === "invalid_provisioning_operation_id") {
      throw httpError(400, error.code, error);
    }
    throw error;
  }
  const sessionCollectionRef = dependencies.sessionCollection(workspaceId);
  const sessionRef = sessionCollectionRef.doc(runtimeSessionId || provisioningSessionId(provisioningOperationId));
  const existingSessionSnap = await sessionRef.get();
  if (existingSessionSnap.exists) {
    const existingSession = existingSessionSnap.data() || {};
    if (existingSession.ownerUid && existingSession.ownerUid !== uid) {
      throw httpError(403, "session_forbidden");
    }
    return toClientDoc(existingSessionSnap);
  }

  const sessionType = cleanName(payload.sessionType || payload.type || "cloud").toLowerCase();
  if (sessionType !== "cloud") throw httpError(400, "unsupported_session_type");
  const markedAgentWorkspace = isMarkedAgentWorkspace(workspace);
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  const region = cleanName(payload.region || DEFAULT_REGION);
  const resources = dependencies.normalizeRequestedSessionResources({
    ...payload,
    ...(payload.resources || {}),
  }, {
    defaultResources: workspace.resources || (process.env.SESSION_CPU || process.env.SESSION_MEMORY ?
      {cpu: DEFAULT_CPU, memory: DEFAULT_MEMORY} : undefined),
  });
  const idleTimeoutMinutes = positiveNumber(
      payload.idleTimeoutMinutes,
      DEFAULT_IDLE_TIMEOUT_MINUTES,
  );
  const serviceId = resolveCloudRunServiceId(sessionRef.id);
  let runnerImage;
  try {
    runnerImage = dependencies.resolveRunnerImage({imageKey: AGENT_IMAGE_KEY});
  } catch (error) {
    if (error && error.code === "invalid_runner_image") {
      throw httpError(400, "invalid_runner_image", error);
    }
    throw error;
  }
  const requestedImageKey = cleanName(payload.imageKey);
  const requestedImage = cleanName(payload.image);
  if (requestedImageKey && requestedImageKey !== AGENT_IMAGE_KEY) {
    throw httpError(400, "invalid_runner_image");
  }
  if (requestedImage && requestedImage !== runnerImage.image) {
    throw httpError(400, "invalid_runner_image");
  }
  const harnessId = "pi";
  const harness = dependencies.resolveHarness(harnessId);
  const envMetadata = sessionEnvMetadata(workspace, payload);
  const session = {
    ownerUid: uid,
    userPath: userPath(uid),
    workspaceId,
    runnerSessionId: sessionRef.id,
    ...(runtimeKind === "automation" ? {
      runtimeKind,
      automationRunId,
    } : {}),
    workspaceStoragePrefix: workspace.storagePrefix,
    piSessionDir: piSessionDir(sessionRef.id),
    piSessionStorageBucket: workspace.bucket || DEFAULT_BUCKET,
    piSessionStoragePrefix: piSessionStoragePrefix(workspace.storagePrefix, sessionRef.id),
    piSessionJsonlPath: null,
    piSessionJsonlRelativePath: null,
    terminalHistoryPath: `workspaces/${workspaceId}/sessions/${sessionRef.id}/terminalHistory`,
    name: cleanName(payload.name || "Terminal session"),
    status: runnerImage.canProvision ? "provisioning" : "needs_image",
    ...initialProvisioningMetadata(provisioningOperationId),
    provisioningState: runnerImage.canProvision ? "queued" : "pending",
    region,
    image: runnerImage.image,
    imageKey: runnerImage.key,
    harnessId,
    sessionType: "cloud",
    terminalKind: harness?.terminalKind || runnerImage.terminalKind || "shell",
    capabilities: runnerImage.capabilities,
    serviceAccount: dependencies.runnerServiceAccountValue() || null,
    serviceId,
    serviceName: cloudRunServiceName(region, serviceId),
    serviceUrl: null,
    workspaceStorageBucket: workspace.bucket || DEFAULT_BUCKET,
    mcpConfig: mcpConfigForRunner(workspace),
    ...sessionSourceMetadata(workspace),
    ...sessionSyncPolicyMetadata(workspace),
    ...sessionHomePolicyMetadata(workspace),
    ...markedAgentSessionMetadata(workspace),
    ...envMetadata,
    environmentEntryIds: [...new Set([
      ...(Array.isArray(workspace.environmentEntryIds) ? workspace.environmentEntryIds : []),
      ...(Array.isArray(payload.environmentEntryIds) ? payload.environmentEntryIds : []),
    ])],
    resources,
    activeSocketCount: 0,
    idleTimeoutMinutes,
    longRunning: false,
    lastActivityAt: now,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    usageAccruedAt: now,
    usageAccruedCpuSeconds: 0,
    usageAccruedMemoryGbSeconds: 0,
    usageAccruedRuntimeSeconds: 0,
    autoStoppedAt: null,
    stopReason: null,
    shutdownToken: crypto.randomBytes(24).toString("hex"),
    browserAccessTokenSecret: crypto.randomBytes(32).toString("hex"),
    createdAt: now,
    updatedAt: now,
    restartedAt: null,
    lastError: runnerImage.canProvision ? null : "Set SESSION_RUNNER_IMAGE before provisioning Cloud Run sessions.",
  };

  const syncWriterEligible = runnerImage.canProvision;
  await dependencies.reserveChromeWorkspaceSession(workspaceId, sessionRef, session, {
    githubWorkspace: isGithubWorkspace(workspace),
    newRuntime: markedAgentWorkspace,
    runtimeOperationId: provisioningOperationId,
    singleRunner: !isAutomationRuntime(session),
    syncWriterEligible,
  });

  if (dependencies.db && typeof dependencies.db.collection === "function") {
    const workspaceRef = dependencies.db.collection("workspaces").doc(workspaceId);
    const latestWorkspaceSnap = await workspaceRef.get();
    if (latestWorkspaceSnap.exists && !latestWorkspaceSnap.data().canonicalSessionId && !isAutomationRuntime(session)) {
      await workspaceRef.update({
        canonicalSessionId: sessionRef.id,
        updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  if (!runnerImage.canProvision) {
    await dependencies.releaseChromeWorkspaceSession(sessionRef, session, "needs_image");
  }

  return toClientDoc(await sessionRef.get());
}

function isGithubWorkspace(workspace) {
  return workspace && workspace.source && workspace.source.type === "github";
}

function sessionSyncPolicyMetadata(workspace) {
  const syncPolicy = workspace && workspace.syncPolicy ? workspace.syncPolicy : {mode: "blank", exclude: []};
  return {
    syncPolicyMode: cleanName(syncPolicy.mode || "blank") || "blank",
    syncPolicyExclude: Array.isArray(syncPolicy.exclude) ?
      syncPolicy.exclude
          .map((value) => canonicalizeInternalStoragePath(cleanName(value)))
          .filter(Boolean) :
      [],
  };
}

function sessionHomePolicyMetadata(workspace) {
  const policy = workspace && workspace.homePolicy ? workspace.homePolicy : {};
  const mode = cleanName(policy.mode || "persistent").toLowerCase() === "ephemeral" ? "ephemeral" : "persistent";
  const homeDir = cleanName(policy.path || "/root") || "/root";
  return {
    homeMode: mode,
    homeDir,
    homeStorageBucket: cleanName(policy.bucket || workspace.bucket || DEFAULT_BUCKET),
    homeStoragePrefix: mode === "persistent" ?
      canonicalizeInternalStoragePath(cleanName(policy.storagePrefix || homeStoragePrefix(workspace.storagePrefix))) :
      "",
    homeArchiveName: cleanName(policy.archiveName || "home.tar.gz") || "home.tar.gz",
  };
}

function sessionEnvMetadata(workspace, payload) {
  return {
    workspaceEnv: normalizeEnvMap(workspace && workspace.env, {
      errorCode: "invalid_workspace_env",
      invalidNameErrorCode: "invalid_workspace_env_name",
      reservedNameErrorCode: "reserved_workspace_env_name",
    }),
    sessionEnv: normalizeEnvMap(payload && payload.env, {
      errorCode: "invalid_session_env",
      invalidNameErrorCode: "invalid_session_env_name",
      reservedNameErrorCode: "reserved_session_env_name",
    }),
  };
}

module.exports = {
  createSessionCreationService,
  sessionEnvMetadata,
  sessionHomePolicyMetadata,
  sessionSyncPolicyMetadata,
};
