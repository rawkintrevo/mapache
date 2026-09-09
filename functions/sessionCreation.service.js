"use strict";

const crypto = require("crypto");
const {
  DEFAULT_BUCKET,
  DEFAULT_CPU,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_IMAGE,
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
  codexHomeDir,
  codexHomeStoragePrefix,
  homeStoragePrefix,
  piSessionDir,
  piSessionStoragePrefix,
  runnerServiceAccountValue,
} = require("./cloudRun.service");
const {isChromeSession} = require("./chromeReservation.helpers");
const {mcpConfigForRunner} = require("./mcpConfig.helpers");
const {sessionSourceMetadata} = require("./github.service");
const {normalizeEnvMap} = require("./env.helpers");
const {normalizeSshSessionPayload} = require("./sshSession.helpers");
const {canonicalizeInternalStoragePath} = require("./runtimePaths.helpers");
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
  let provisioningOperationId;
  try {
    provisioningOperationId = normalizeProvisioningOperationId(
        payload.operationId || payload.provisioningOperationId || payload.idempotencyKey,
    );
  } catch (error) {
    if (error && error.code === "invalid_provisioning_operation_id") {
      throw httpError(400, error.code, error);
    }
    throw error;
  }
  const sessionCollectionRef = dependencies.sessionCollection(workspaceId);
  const sessionRef = sessionCollectionRef.doc(provisioningSessionId(provisioningOperationId));
  const existingSessionSnap = await sessionRef.get();
  if (existingSessionSnap.exists) {
    const existingSession = existingSessionSnap.data() || {};
    if (existingSession.ownerUid && existingSession.ownerUid !== uid) {
      throw httpError(403, "session_forbidden");
    }
    return toClientDoc(existingSessionSnap);
  }

  const workspaceSshSource = workspace.source && workspace.source.type === "ssh" ? workspace.source : null;
  const sessionType = cleanName(payload.sessionType || payload.type || (workspaceSshSource ? "ssh" : "cloud")).toLowerCase();
  const sshPayload = sessionType === "ssh" ?
    await normalizeCreateSessionSshPayload(uid, workspaceId, workspaceSshSource, payload, dependencies) :
    null;
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  const region = cleanName(payload.region || DEFAULT_REGION);
  const resources = dependencies.normalizeRequestedSessionResources(payload, {
    defaultResources: sshPayload ?
      {cpu: DEFAULT_CPU, memory: DEFAULT_MEMORY} :
      (process.env.SESSION_CPU || process.env.SESSION_MEMORY ?
        {cpu: DEFAULT_CPU, memory: DEFAULT_MEMORY} : undefined),
  });
  const idleTimeoutMinutes = positiveNumber(
      payload.idleTimeoutMinutes,
      DEFAULT_IDLE_TIMEOUT_MINUTES,
  );
  const serviceId = resolveCloudRunServiceId(sessionRef.id);
  let runnerImage;
  try {
    runnerImage = dependencies.resolveRunnerImage(sshPayload ? {...payload, imageKey: "default"} : payload, DEFAULT_IMAGE);
  } catch (error) {
    if (error && error.code === "invalid_runner_image") {
      throw httpError(400, "invalid_runner_image", error);
    }
    throw error;
  }
  const harnessId = sshPayload ? "ssh" : (runnerImage.harnessId || "shell");
  const harness = dependencies.resolveHarness(harnessId);
  const envMetadata = sessionEnvMetadata(workspace, payload);
  const session = {
    ownerUid: uid,
    userPath: userPath(uid),
    workspaceId,
    runnerSessionId: sessionRef.id,
    workspaceStoragePrefix: workspace.storagePrefix,
    piSessionDir: piSessionDir(sessionRef.id),
    piSessionStorageBucket: workspace.bucket || DEFAULT_BUCKET,
    piSessionStoragePrefix: piSessionStoragePrefix(workspace.storagePrefix, sessionRef.id),
    piSessionJsonlPath: null,
    piSessionJsonlRelativePath: null,
    codexHomeDir: harnessId === "codex" ? codexHomeDir(sessionRef.id) : "",
    codexHomeStorageBucket: harnessId === "codex" ? (workspace.bucket || DEFAULT_BUCKET) : "",
    codexHomeStoragePrefix: harnessId === "codex" ? codexHomeStoragePrefix(workspace.storagePrefix, sessionRef.id) : "",
    terminalHistoryPath: `workspaces/${workspaceId}/sessions/${sessionRef.id}/terminalHistory`,
    name: cleanName(payload.name || "Terminal session"),
    status: runnerImage.canProvision ? "provisioning" : "needs_image",
    ...initialProvisioningMetadata(provisioningOperationId),
    provisioningState: runnerImage.canProvision ? "queued" : "pending",
    region,
    image: runnerImage.image,
    imageKey: runnerImage.key,
    harnessId,
    sessionType: sshPayload ? "ssh" : "cloud",
    terminalKind: harness?.terminalKind || runnerImage.terminalKind || "shell",
    capabilities: sshPayload ? {...runnerImage.capabilities, preview: false, ssh: true, sshFiles: true, sshForwarding: true} : runnerImage.capabilities,
    serviceAccount: dependencies.runnerServiceAccountValue() || null,
    serviceId,
    serviceName: cloudRunServiceName(region, serviceId),
    serviceUrl: null,
    workspaceStorageBucket: workspace.bucket || DEFAULT_BUCKET,
    mcpConfig: mcpConfigForRunner(workspace),
    ...sessionSourceMetadata(workspace),
    ...sessionSyncPolicyMetadata(workspace),
    ...sessionHomePolicyMetadata(workspace),
    ...envMetadata,
    environmentEntryIds: [...new Set([
      ...(Array.isArray(workspace.environmentEntryIds) ? workspace.environmentEntryIds : []),
      ...(Array.isArray(payload.environmentEntryIds) ? payload.environmentEntryIds : []),
    ])],
    ...(sshPayload ? {
      sshTarget: sshPayload.public,
      sessionEnv: {
        ...(envMetadata.sessionEnv || {}),
        SSH_TARGET_HOST: sshPayload.public.host,
        SSH_TARGET_PORT: String(sshPayload.public.port),
        SSH_TARGET_USERNAME: sshPayload.public.username,
        SSH_INITIAL_DIRECTORY: sshPayload.public.initialDirectory,
        SSH_AUTH_MODE: sshPayload.public.auth.type === "openssh-user-certificate" ? "certificate" : "private-key",
        SSH_STRICT_HOST_KEY_CHECKING: sshPayload.public.auth.strictHostKeyChecking ? "true" : "false",
      },
    } : {}),
    resources,
    activeSocketCount: 0,
    idleTimeoutMinutes,
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
  if (isChromeSession(session)) {
    await dependencies.reserveChromeWorkspaceSession(workspaceId, sessionRef, session, {
      githubWorkspace: isGithubWorkspace(workspace),
      syncWriterEligible,
    });
  } else if (isGithubWorkspace(workspace)) {
    await dependencies.reserveGithubWorkspaceSession(workspaceId, sessionRef, session, {syncWriterEligible});
  } else {
    await dependencies.reserveWorkspaceSyncSession(workspaceId, sessionRef, session, {syncWriterEligible});
  }

  if (!runnerImage.canProvision && isChromeSession(session)) {
    await dependencies.releaseChromeWorkspaceSession(sessionRef, session, "needs_image");
  }

  return toClientDoc(await sessionRef.get());
}

async function normalizeCreateSessionSshPayload(uid, workspaceId, workspaceSshSource, payload, dependencies) {
  if (payload && payload.sshTarget) return normalizeSshSessionPayload(payload);
  if (!workspaceSshSource) return normalizeSshSessionPayload(payload);
  const privateSnap = await dependencies.db.collection("users").doc(uid).collection("private").doc(`sshWorkspace_${workspaceId}`).get();
  if (!privateSnap.exists) throw httpError(409, "ssh_workspace_auth_missing");
  const secrets = privateSnap.data() || {};
  return normalizeSshSessionPayload({
    sshTarget: {
      ...(workspaceSshSource.target || {}),
      privateKey: secrets.privateKey,
      certificate: secrets.certificate,
      knownHosts: secrets.knownHosts,
      authMode: secrets.authMode || workspaceSshSource.target?.auth?.type,
      strictHostKeyChecking: workspaceSshSource.target?.auth?.strictHostKeyChecking,
    },
  });
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
