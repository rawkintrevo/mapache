"use strict";

const crypto = require("crypto");
const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const {
  admin,
  db,
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
  userPath,
} = require("./backendUtils.helpers");
const {resolveRunnerImage} = require("./runnerImages.helpers");
const {routeRequest: apiRouteRequest} = require("./apiRoutes.helpers");
const {dispatchApiRoute} = require("./apiDispatch.helpers");
const {requireUser} = require("./auth.service");
const {
  accrueSessionUsage,
  isTerminalSessionStatus,
  sessionUsageRecord,
  userWithUsage,
} = require("./userUsage.service");
const {
  createWorkspaceService,
  normalizeWorkspaceFilePath,
  requireWorkspace,
} = require("./workspace.service");
const {
  createCloudRunService,
  homeStoragePrefix,
  normalizeResources,
  piSessionDir,
  piSessionStoragePrefix,
  runnerServiceAccountValue,
} = require("./cloudRun.service");
const {normalizeEnvMap} = require("./env.helpers");
const {
  cleanGithubNumericId,
  createGithubService,
  sessionSourceMetadata,
} = require("./github.service");
const {createPiService} = require("./pi.service");
const {createQaAuthService} = require("./qaAuth.service");

const githubService = createGithubService();
const piService = createPiService({
  requireSession,
  requireWorkspace,
  requestRunnerJson,
});
const qaAuthService = createQaAuthService();
const cloudRunService = createCloudRunService({
  buildGithubAuthEnv: githubService.buildGithubAuthEnv,
  markSessionStopped,
});
const {
  deleteSessionService,
  patchSessionService,
  provisionSessionService,
} = cloudRunService;

const workspaceService = createWorkspaceService({
  deleteSessionService,
  isConnectedGithubSourcePayload: githubService.isConnectedGithubSourcePayload,
  normalizeConnectedGithubSourcePayload: githubService.normalizeConnectedGithubSourcePayload,
});

const API_HANDLERS = {
  userWithUsage,
  getPiAuth: piService.getPiAuth,
  savePiAuthProvider: piService.savePiAuthProvider,
  deletePiAuthProvider: piService.deletePiAuthProvider,
  deletePiAuthEntry: piService.deletePiAuthEntry,
  startOpenAiCodexDeviceCode: piService.startOpenAiCodexDeviceCode,
  completeOpenAiCodexDeviceCode: piService.completeOpenAiCodexDeviceCode,
  listWorkspaces: workspaceService.listWorkspaces,
  createWorkspace: workspaceService.createWorkspace,
  deleteWorkspace: workspaceService.deleteWorkspace,
  listWorkspaceFiles: workspaceService.listWorkspaceFiles,
  readWorkspaceFile: workspaceService.readWorkspaceFile,
  saveWorkspaceFile: workspaceService.saveWorkspaceFile,
  uploadWorkspaceFile: workspaceService.uploadWorkspaceFile,
  createWorkspaceFileDownloadUrl: workspaceService.createWorkspaceFileDownloadUrl,
  listSessions,
  createSession,
  resizeSession,
  restartSession,
  stopSession,
  deleteSession,
  createSessionAccessUrls,
  saveSessionPiAuthSelection: piService.saveSessionPiAuthSelection,
  getGitStatusSummary,
  pullGit,
  stageGit,
  unstageGit,
  commitGit,
  pushGit,
  openPullRequest,
  listPiPackages: piService.listPiPackages,
  installPiPackage: piService.installPiPackage,
  removePiPackage: piService.removePiPackage,
  updatePiPackage: piService.updatePiPackage,
  listPiSkills: piService.listPiSkills,
  savePiSkill: piService.savePiSkill,
  deletePiSkill: piService.deletePiSkill,
  listConnectedRepos: githubService.listConnectedRepos,
  createGithubConnectUrl: githubService.createGithubConnectUrl,
  getGithubConnection: githubService.getGithubConnection,
  disconnectGithub: githubService.disconnectGithub,
};

exports.api = onRequest({
  cors: true,
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

    const user = await requireUser(req);

    await dispatchApiRoute({route, req, res, user, handlers: API_HANDLERS});
  } catch (error) {
    logger.error("api request failed", error);
    const status = error.status || 500;
    res.status(status).json({error: error.publicMessage || "internal_error"});
  }
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
    await doc.ref.update({
      status: "stopping",
      stopReason: "idle_timeout",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
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
  return snap.docs.map(toClientDoc);
}

async function createSession(uid, workspaceId, payload) {
  const workspace = await requireWorkspace(uid, workspaceId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const sessionRef = sessionCollection(workspaceId).doc();
  const region = cleanName(payload.region || DEFAULT_REGION);
  const resources = normalizeResources(payload);
  const idleTimeoutMinutes = positiveNumber(
      payload.idleTimeoutMinutes,
      DEFAULT_IDLE_TIMEOUT_MINUTES,
  );
  const serviceId = `session-${sessionRef.id.toLowerCase()}`;
  let runnerImage;
  try {
    runnerImage = resolveRunnerImage(payload, DEFAULT_IMAGE);
  } catch (error) {
    if (error && error.code === "invalid_runner_image") {
      throw httpError(400, "invalid_runner_image", error);
    }
    throw error;
  }
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
    terminalHistoryPath: `workspaces/${workspaceId}/sessions/${sessionRef.id}/terminalHistory`,
    name: cleanName(payload.name || "Terminal session"),
    status: runnerImage.canProvision ? "provisioning" : "needs_image",
    region,
    image: runnerImage.image,
    imageKey: runnerImage.key,
    terminalKind: runnerImage.terminalKind || "pi",
    capabilities: runnerImage.capabilities,
    serviceAccount: runnerServiceAccountValue() || null,
    serviceId,
    serviceName: cloudRunServiceName(region, serviceId),
    serviceUrl: null,
    workspaceStorageBucket: workspace.bucket || DEFAULT_BUCKET,
    ...sessionSourceMetadata(workspace),
    ...sessionSyncPolicyMetadata(workspace),
    ...sessionHomePolicyMetadata(workspace),
    ...sessionEnvMetadata(workspace, payload),
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

  if (isGithubWorkspace(workspace)) {
    await reserveGithubWorkspaceSession(workspaceId, sessionRef, session);
  } else {
    await sessionRef.set(session);
  }

  if (runnerImage.canProvision) {
    await provisionSessionService(workspace, sessionRef, session);
  }

  return toClientDoc(await sessionRef.get());
}

async function createSessionAccessUrls(uid, workspaceId, sessionId) {
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.browserAccessTokenSecret) {
    throw httpError(409, "session_requires_restart_for_browser_access");
  }

  const expiresAtMs = Date.now() + SESSION_BROWSER_ACCESS_TTL_MS;
  const token = signSessionBrowserAccessToken(session, expiresAtMs);
  const baseUrl = session.serviceUrl.replace(/\/+$/, "");
  const terminalUrl = appendQuery(`${baseUrl}/`, "mapache_access", token);
  const previewUrl = appendQuery(`${baseUrl}/preview/`, "mapache_access", token);
  return {
    ok: true,
    expiresAt: new Date(expiresAtMs).toISOString(),
    terminalUrl,
    previewUrl,
  };
}

function signSessionBrowserAccessToken(session, expiresAtMs) {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(expiresAtMs / 1000),
    sid: session.runnerSessionId || session.id || "",
  })).toString("base64url");
  const signature = crypto
      .createHmac("sha256", session.browserAccessTokenSecret)
      .update(payload)
      .digest("base64url");
  return `${payload}.${signature}`;
}

function appendQuery(url, key, value) {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

async function reserveGithubWorkspaceSession(workspaceId, sessionRef, session) {
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(sessionCollection(workspaceId));
    const activeSession = snap.docs.find((doc) => {
      const active = doc.data();
      return isActiveGithubWorkspaceSession(active) && !isShellSession(active) && !isShellSession(session);
    });
    if (activeSession) {
      throw httpError(409, "This GitHub workspace already has an active session. Stop it before creating another one.");
    }
    transaction.set(sessionRef, session);
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
  const resources = normalizeResources(payload);
  const resizedAt = admin.firestore.Timestamp.now();
  await sessionRef.update({
    ...accrueSessionUsage(sessionSnap.data(), resizedAt),
    resources,
    status: "resizing",
    updatedAt: resizedAt,
  });
  await patchSessionService(sessionRef, {...sessionSnap.data(), resources});
  return toClientDoc(await sessionRef.get());
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

  const restartedAt = admin.firestore.Timestamp.now();
  const browserAccessTokenSecret = session.browserAccessTokenSecret || crypto.randomBytes(32).toString("hex");
  const restartNonce = Date.now().toString();
  const restartUpdate = {
    status: recreatingSessionService ? "provisioning" : "restarting",
    browserAccessTokenSecret,
    restartNonce,
    restartedAt,
    stoppedAt: null,
    autoStoppedAt: null,
    stopReason: null,
    serviceUrl: null,
    lastError: null,
    updatedAt: restartedAt,
  };

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

  if (recreatingSessionService) {
    await provisionSessionService(workspace, sessionRef, restartedSession);
  } else {
    await patchSessionService(sessionRef, restartedSession, {restart: true});
  }

  return toClientDoc(await sessionRef.get());
}

async function stopSession(uid, workspaceId, sessionId) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  await sessionRef.update({
    status: "stopping",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await deleteSessionService(sessionRef, sessionSnap.data(), {reason: "manual"});
  return toClientDoc(await sessionRef.get());
}

async function deleteSession(uid, workspaceId, sessionId) {
  const {sessionRef, sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  await sessionRef.update({
    status: "deleting",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const serviceDeleted = await deleteSessionService(sessionRef, sessionSnap.data(), {reason: "deleted"});
  if (!serviceDeleted) {
    throw httpError(502, "session_delete_failed");
  }
  await sessionRef.delete();
  return {ok: true};
}


async function getGitStatusSummary(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};

  if (!session.serviceUrl) {
    throw httpError(409, "session_not_running");
  }
  if (!session.shutdownToken) {
    throw httpError(503, "runner_git_status_unavailable");
  }

  return requestRunnerGitStatus(session);
}

async function pullGit(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};

  if (!session.serviceUrl) {
    throw httpError(409, "session_not_running");
  }
  if (!session.shutdownToken) {
    throw httpError(503, "runner_git_pull_unavailable");
  }

  return requestRunnerGitPull(session);
}

async function stageGit(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_stage_unavailable");
  return requestRunnerGitStage(session, {paths: normalizeGitActionPayloadPaths(payload)});
}

async function unstageGit(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_unstage_unavailable");
  return requestRunnerGitUnstage(session, {paths: normalizeGitActionPayloadPaths(payload)});
}

async function commitGit(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_commit_unavailable");
  return requestRunnerGitCommit(session, {message: normalizeGitCommitMessage(payload)});
}

async function pushGit(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_push_unavailable");
  if (cleanName(session.sourceType) === "github" && cleanName(session.sourceMode) === "connected") {
    const installationId = cleanGithubNumericId(session.sourceInstallationId);
    if (!installationId) {
      throw httpError(503, "github_push_auth_unavailable");
    }
    const tokenResponse = await githubService.createGithubInstallationToken(installationId);
    return requestRunnerGitPush(session, {
      pushToken: tokenResponse.token,
      pushUsername: "x-access-token",
    });
  }
  return requestRunnerGitPush(session);
}

async function openPullRequest(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  return githubService.openPullRequestForSession(session, payload, requestRunnerGitOpenPr);
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
  const stoppedAt = admin.firestore.Timestamp.now();
  const usageRecord = sessionUsageRecord(sessionRef, session, stoppedAt);
  const stopped = {
    status: "stopped",
    activeSocketCount: 0,
    serviceUrl: null,
    stoppedAt,
    lastError: null,
    updatedAt: stoppedAt,
  };
  if (reason) stopped.stopReason = reason;
  if (reason === "idle_timeout") {
    stopped.autoStoppedAt = stoppedAt;
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

function sessionSyncPolicyMetadata(workspace) {
  const syncPolicy = workspace && workspace.syncPolicy ? workspace.syncPolicy : {mode: "blank", exclude: []};
  return {
    syncPolicyMode: cleanName(syncPolicy.mode || "blank") || "blank",
    syncPolicyExclude: Array.isArray(syncPolicy.exclude) ?
      syncPolicy.exclude.map((value) => cleanName(value)).filter(Boolean) :
      [],
  };
}

function sessionHomePolicyMetadata(workspace) {
  const policy = workspace && workspace.homePolicy ? workspace.homePolicy : {};
  const mode = cleanName(policy.mode || "persistent").toLowerCase() === "ephemeral" ? "ephemeral" : "persistent";
  const path = cleanName(policy.path || "/root") || "/root";
  return {
    homeMode: mode,
    homeDir: path,
    homeStorageBucket: cleanName(policy.bucket || workspace.bucket || DEFAULT_BUCKET),
    homeStoragePrefix: mode === "persistent" ?
      cleanName(policy.storagePrefix || homeStoragePrefix(workspace.storagePrefix)) :
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

async function requestRunnerGitStatus(session) {
  return requestRunnerJson(session, "/git/status", {
    unavailableError: "runner_git_status_unavailable",
  });
}

async function requestRunnerGitPull(session) {
  return requestRunnerJson(session, "/git/pull", {
    method: "POST",
    unavailableError: "runner_git_pull_unavailable",
  });
}

async function requestRunnerGitStage(session, body) {
  return requestRunnerJson(session, "/git/stage", {
    method: "POST",
    body,
    unavailableError: "runner_git_stage_unavailable",
  });
}

async function requestRunnerGitUnstage(session, body) {
  return requestRunnerJson(session, "/git/unstage", {
    method: "POST",
    body,
    unavailableError: "runner_git_unstage_unavailable",
  });
}

async function requestRunnerGitCommit(session, body) {
  return requestRunnerJson(session, "/git/commit", {
    method: "POST",
    body,
    unavailableError: "runner_git_commit_unavailable",
  });
}

async function requestRunnerGitPush(session, body) {
  return requestRunnerJson(session, "/git/push", {
    method: "POST",
    body,
    unavailableError: "runner_git_push_unavailable",
  });
}

async function requestRunnerGitOpenPr(session, body) {
  return requestRunnerJson(session, "/git/open-pr", {
    method: "POST",
    body,
    unavailableError: "runner_git_open_pr_unavailable",
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
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 404 && options.notFoundError) {
        throw httpError(options.notFoundStatus || 503, options.notFoundError);
      }
      throw httpError(
          response.status === 404 ? 503 : response.status,
          cleanName(data.error || options.failureError || "runner_request_failed") ||
            options.failureError ||
            "runner_request_failed",
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

function normalizeGitActionPayloadPaths(payload) {
  const paths = payload && Array.isArray(payload.paths) ? payload.paths : null;
  if (!paths || !paths.length) {
    throw httpError(400, "invalid_git_paths");
  }
  return paths.map((value) => normalizeWorkspaceFilePath(value));
}

function normalizeGitCommitMessage(payload) {
  const message = cleanName(payload && payload.message ? payload.message : "").trim();
  if (!message) {
    throw httpError(400, "missing_commit_message");
  }
  return message;
}
