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
  SESSION_BROWSER_ACCESS_TTL_MS,
} = require("./backendConfig");
const {
  cleanName,
  cloudRunServiceName,
  httpError,
  latestTimestampMillis,
  normalizeStoragePrefix,
  positiveNumber,
  toClientDoc,
  userPath,
} = require("./backendUtils.helpers");
const {resolveRunnerImage} = require("./runnerImages.helpers");
const {
  OPENAI_CODEX_PROVIDER,
  routeRequest: apiRouteRequest,
} = require("./apiRoutes.helpers");
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
  normalizeResources,
  piHomeStoragePrefix,
  piSessionDir,
  piSessionStoragePrefix,
  runnerServiceAccountValue,
} = require("./cloudRun.service");
const {
  cleanGithubNumericId,
  createGithubService,
  sessionSourceMetadata,
} = require("./github.service");

const githubService = createGithubService();
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

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_SCOPE = "openid profile email offline_access";
const OPENAI_CODEX_DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_CODEX_DEVICE_VERIFICATION_URI = "https://auth.openai.com/codex/device";
const OPENAI_CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const OPENAI_CODEX_ACCOUNT_CLAIM_PATH = "https://api.openai.com/auth";
const PI_AUTH_API_KEY_PROVIDERS = new Set([
  "anthropic",
  "ant-ling",
  "azure-openai-responses",
  "openai",
  "deepseek",
  "nvidia",
  "google",
  "mistral",
  "groq",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "zai-coding-cn",
  "opencode",
  "opencode-go",
  "huggingface",
  "fireworks",
  "together",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
]);

const API_HANDLERS = {
  userWithUsage,
  getPiAuth,
  savePiAuthProvider,
  deletePiAuthProvider,
  deletePiAuthEntry,
  startOpenAiCodexDeviceCode,
  completeOpenAiCodexDeviceCode,
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
  saveSessionPiAuthSelection,
  getGitStatusSummary,
  pullGit,
  stageGit,
  unstageGit,
  commitGit,
  pushGit,
  openPullRequest,
  listPiPackages,
  installPiPackage,
  removePiPackage,
  updatePiPackage,
  listPiSkills,
  savePiSkill,
  deletePiSkill,
  listConnectedRepos: githubService.listConnectedRepos,
  createGithubConnectUrl: githubService.createGithubConnectUrl,
};

exports.api = onRequest({
  cors: true,
  secrets: [
    GITHUB_APP_ID_SECRET,
    GITHUB_APP_CLIENT_ID_SECRET,
    GITHUB_APP_CLIENT_SECRET_SECRET,
    GITHUB_APP_PRIVATE_KEY_SECRET,
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

async function getPiAuth(uid) {
  const snap = await piAuthDoc(uid).get();
  const data = snap.exists ? snap.data() : {};
  const providers = normalizePiAuthProviders(data.providers);
  return {providers, entries: normalizePiAuthEntries(data.entries, providers)};
}

async function savePiAuthProvider(uid, provider, payload) {
  const providerKey = normalizePiAuthProviderKey(provider);
  const apiKey = normalizePiAuthApiKey(payload && payload.key);
  await savePiAuthCredential(uid, providerKey, {type: "api_key", key: apiKey}, payload && payload.label);
  return getPiAuth(uid);
}

async function deletePiAuthProvider(uid, provider) {
  const providerKey = normalizePiAuthStoredProviderKey(provider);
  const ref = piAuthDoc(uid);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const data = snap.exists ? snap.data() : {};
    const current = normalizePiAuthProviders(data.providers);
    const entries = normalizePiAuthEntries(data.entries, current);
    delete current[providerKey];
    const filteredEntries = Object.entries(entries).reduce((acc, [id, entry]) => {
      if (entry.providerKey !== providerKey) acc[id] = entry;
      return acc;
    }, {});
    transaction.set(ref, {
      providers: current,
      entries: filteredEntries,
      updatedAt: now,
      ...(snap.exists ? {} : {createdAt: now}),
    }, {merge: true});
  });
  return getPiAuth(uid);
}

async function deletePiAuthEntry(uid, entryId) {
  const normalizedEntryId = normalizePiAuthEntryId(entryId);
  const ref = piAuthDoc(uid);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const data = snap.exists ? snap.data() : {};
    const providers = normalizePiAuthProviders(data.providers);
    const entries = normalizePiAuthEntries(data.entries, providers);
    const entry = entries[normalizedEntryId];
    if (!entry) return;
    delete entries[normalizedEntryId];
    const latestForProvider = Object.values(entries)
        .filter((item) => item.providerKey === entry.providerKey)
        .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
    const nextProviders = {...providers};
    if (latestForProvider) nextProviders[entry.providerKey] = latestForProvider.credential;
    else delete nextProviders[entry.providerKey];
    transaction.set(ref, {
      providers: nextProviders,
      entries,
      updatedAt: now,
      ...(snap.exists ? {} : {createdAt: now}),
    }, {merge: true});
  });
  return getPiAuth(uid);
}

async function savePiAuthCredential(uid, providerKey, credential, label = "") {
  const ref = piAuthDoc(uid);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const data = snap.exists ? snap.data() : {};
    const current = normalizePiAuthProviders(data.providers);
    const entries = normalizePiAuthEntries(data.entries, current);
    const cleanCredential = normalizePlainObject(credential);
    const entryId = buildPiAuthEntryId(providerKey);
    const createdAt = new Date().toISOString();
    transaction.set(ref, {
      providers: {
        ...current,
        [providerKey]: cleanCredential,
      },
      entries: {
        ...entries,
        [entryId]: {
          id: entryId,
          providerKey,
          label: cleanName(label) || defaultPiAuthEntryLabel(providerKey, entries),
          credential: cleanCredential,
          createdAt,
        },
      },
      updatedAt: now,
      ...(snap.exists ? {} : {createdAt: now}),
    }, {merge: true});
  });
}

async function startOpenAiCodexOAuth(uid, payload) {
  const returnTo = normalizeOpenAiCodexReturnTo(payload.returnTo);
  const redirectUri = `${new URL(returnTo).origin}/api/pi-auth/providers/${OPENAI_CODEX_PROVIDER}/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  const expiresAt = Date.now() + 15 * 60 * 1000;

  await openAiCodexOAuthStateDoc(state).set({
    uid,
    verifier,
    redirectUri,
    returnTo,
    expiresAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OPENAI_CODEX_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");

  return {authUrl: url.toString(), redirectUri};
}

async function handleOpenAiCodexOAuthCallback(req, res) {
  const state = String(req.query.state || "").trim();
  const code = String(req.query.code || "").trim();
  const providerError = String(req.query.error || "").trim();
  const ref = openAiCodexOAuthStateDoc(state);
  const snap = state ? await ref.get() : null;
  const record = snap && snap.exists ? snap.data() : null;
  const returnTo = record?.returnTo || "/";

  try {
    if (!record) throw httpError(400, "openai_codex_oauth_state_not_found");
    if (Number(record.expiresAt || 0) < Date.now()) throw httpError(400, "openai_codex_oauth_state_expired");
    if (providerError) throw httpError(400, `openai_codex_oauth_error: ${providerError}`);
    if (!code) throw httpError(400, "openai_codex_oauth_missing_code");

    const oauth = await exchangeOpenAiCodexAuthorizationCode(code, record.verifier, record.redirectUri);
    await savePiAuthCredential(record.uid, OPENAI_CODEX_PROVIDER, {type: "oauth", ...oauth});
    await ref.delete().catch(() => {});
    res.redirect(303, appendQuery(returnTo, {openAiCodexLogin: "success"}));
  } catch (error) {
    logger.error("openai codex oauth callback failed", error);
    await ref.delete().catch(() => {});
    res.redirect(303, appendQuery(returnTo, {
      openAiCodexLogin: "error",
      error: publicErrorMessage(error),
    }));
  }
}

async function startOpenAiCodexDeviceCode() {
  const response = await fetch(OPENAI_CODEX_DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({client_id: OPENAI_CODEX_CLIENT_ID}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw httpError(502, `openai_codex_device_code_failed${text ? `: ${text}` : ""}`);
  }

  const data = await response.json();
  const intervalSeconds = typeof data.interval === "string" ? Number(data.interval.trim()) : data.interval;
  if (!data.device_auth_id || !data.user_code || !Number.isFinite(intervalSeconds)) {
    throw httpError(502, "openai_codex_device_code_invalid_response");
  }

  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUri: OPENAI_CODEX_DEVICE_VERIFICATION_URI,
    intervalSeconds: Math.max(1, intervalSeconds),
    expiresInSeconds: 15 * 60,
  };
}

async function completeOpenAiCodexDeviceCode(uid, payload) {
  const deviceAuthId = cleanOpenAiCodexDeviceField(payload.deviceAuthId);
  const userCode = cleanOpenAiCodexDeviceField(payload.userCode);
  if (!deviceAuthId || !userCode) throw httpError(400, "invalid_openai_codex_device_code");

  const tokenResponse = await fetch(OPENAI_CODEX_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({device_auth_id: deviceAuthId, user_code: userCode}),
  });

  if (!tokenResponse.ok) {
    if (tokenResponse.status === 403 || tokenResponse.status === 404) {
      return {status: "pending"};
    }
    const text = await tokenResponse.text().catch(() => "");
    const errorCode = parseOpenAiCodexErrorCode(text);
    if (errorCode === "deviceauth_authorization_pending" || errorCode === "slow_down") {
      return {status: "pending"};
    }
    throw httpError(502, `openai_codex_device_poll_failed${text ? `: ${text}` : ""}`);
  }

  const deviceToken = await tokenResponse.json();
  if (!deviceToken.authorization_code || !deviceToken.code_verifier) {
    throw httpError(502, "openai_codex_device_token_invalid_response");
  }

  const oauth = await exchangeOpenAiCodexAuthorizationCode(
      deviceToken.authorization_code,
      deviceToken.code_verifier,
  );
  await savePiAuthCredential(uid, OPENAI_CODEX_PROVIDER, {type: "oauth", ...oauth});
  return {status: "complete", ...(await getPiAuth(uid))};
}

async function exchangeOpenAiCodexAuthorizationCode(code, verifier, redirectUri = OPENAI_CODEX_DEVICE_REDIRECT_URI) {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw httpError(502, `openai_codex_token_exchange_failed${text ? `: ${text}` : ""}`);
  }

  const data = await response.json();
  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw httpError(502, "openai_codex_token_invalid_response");
  }

  const accountId = openAiCodexAccountId(data.access_token);
  if (!accountId) throw httpError(502, "openai_codex_missing_account_id");
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    accountId,
  };
}

function normalizeOpenAiCodexReturnTo(value) {
  const text = String(value || "").trim();
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid protocol");
    url.hash = "";
    return url.toString();
  } catch (error) {
    throw httpError(400, "invalid_openai_codex_return_url");
  }
}

function openAiCodexOAuthStateDoc(state) {
  return db.collection("oauthStates").doc(`${OPENAI_CODEX_PROVIDER}-${state}`);
}

function base64Url(buffer) {
  return Buffer.from(buffer)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
}

function appendQuery(url, params) {
  try {
    const parsed = new URL(url);
    Object.entries(params).forEach(([key, value]) => parsed.searchParams.set(key, String(value || "")));
    return parsed.toString();
  } catch (error) {
    const query = new URLSearchParams(params).toString();
    return `/?${query}`;
  }
}

function publicErrorMessage(error) {
  return error?.publicMessage || error?.message || "openai_codex_oauth_failed";
}

function cleanOpenAiCodexDeviceField(value) {
  const text = String(value || "").trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.length > 2048) return "";
  return text;
}

function parseOpenAiCodexErrorCode(text) {
  try {
    const data = JSON.parse(text || "{}");
    const error = data && data.error;
    if (typeof error === "string") return error;
    if (error && typeof error.code === "string") return error.code;
  } catch (error) {
    return "";
  }
  return "";
}

function openAiCodexAccountId(accessToken) {
  try {
    const parts = String(accessToken || "").split(".");
    if (parts.length !== 3) return "";
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const claim = payload && payload[OPENAI_CODEX_ACCOUNT_CLAIM_PATH];
    return typeof claim?.chatgpt_account_id === "string" ? claim.chatgpt_account_id : "";
  } catch (error) {
    return "";
  }
}

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
    piHomeStorageBucket: DEFAULT_BUCKET || workspace.bucket,
    piHomeStoragePrefix: piHomeStoragePrefix(uid),
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


async function saveSessionPiAuthSelection(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (cleanName(session.terminalKind || "pi") !== "pi") {
    throw httpError(400, "not_pi_session");
  }
  const piAuth = await getPiAuth(uid);
  const selection = normalizePiAuthSelection(payload && payload.selection, piAuth.entries);
  await sessionSnap.ref.set({
    piAuthSelection: selection,
    piAuthSelectionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});

  let materialized = {ok: true, appliedToRunner: false, providerCount: Object.keys(selection).length};
  if (session.serviceUrl && session.shutdownToken) {
    materialized = await requestRunnerPiAuthMaterialize(session, {selection});
  }
  return {ok: true, selection, materialized};
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

async function installPiPackage(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = normalizePiPackageSource(payload.source);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_install_unsupported");
  const result = await requestRunnerPiPackageInstall(session, {source: packageSource.source});
  await mergeInstalledPiPackageCatalogEntry(uid, workspaceId, packageSource.source);
  return result;
}

async function mergeInstalledPiPackageCatalogEntry(uid, workspaceId, source) {
  const normalized = normalizePiPackageSource(source);
  const ref = piPackageCatalogCollection(uid).doc(piPackageCatalogDocId(normalized.identity));
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    transaction.set(ref, piPackageCatalogRecord(source, workspaceId, {
      includeCreatedAt: !snap.exists,
      incrementInstallCount: true,
    }), {merge: true});
  });
}

async function removePiPackage(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = normalizePiPackageSource(payload.source);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_remove_unsupported");
  return requestRunnerPiPackageRemove(session, {source: packageSource.source});
}

async function updatePiPackage(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = payload.source ? normalizePiPackageSource(payload.source) : null;
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_update_unsupported");
  return requestRunnerPiPackageUpdate(session, packageSource ? {source: packageSource.source} : {});
}

async function listPiPackages(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_listing_unsupported");
  const data = await requestRunnerPiPackages(session);
  await recordObservedPiPackages(uid, workspaceId, data).catch((error) => {
    logger.warn("observed package catalog update failed", {workspaceId, sessionId, error: error.message || error});
  });
  const knownPackages = await listKnownPiPackages(uid, data).catch((error) => {
    logger.warn("known package catalog read failed", {workspaceId, sessionId, error: error.message || error});
    return [];
  });
  return {...data, knownPackages};
}

async function listPiSkills(uid, workspaceId, sessionId) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_listing_unsupported");
  return requestRunnerPiSkills(session);
}

async function savePiSkill(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const skill = normalizePiSkillPayload(payload);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_save_unsupported");
  return requestRunnerPiSkillSave(session, skill);
}

async function deletePiSkill(uid, workspaceId, sessionId, payload) {
  await requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const skillName = normalizePiSkillName(payload.name);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_delete_unsupported");
  return requestRunnerPiSkillDelete(session, {name: skillName});
}

async function listKnownPiPackages(uid, data) {
  const configuredSources = new Set((data && Array.isArray(data.packages) ? data.packages : [])
      .map((packageInfo) => packageInfo && packageInfo.source)
      .filter(Boolean));
  const snap = await piPackageCatalogCollection(uid).get();
  return snap.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .filter((packageInfo) => packageInfo.source && !configuredSources.has(packageInfo.source))
      .map((packageInfo) => ({
        source: packageInfo.source,
        identity: packageInfo.identity || "",
        type: packageInfo.type || "",
        favorite: Boolean(packageInfo.favorite),
        lastWorkspaceId: packageInfo.lastWorkspaceId || "",
        installCount: Number(packageInfo.installCount || 0),
      }))
      .sort((left, right) => left.source.localeCompare(right.source));
}

async function recordObservedPiPackages(uid, workspaceId, data) {
  const packages = data && Array.isArray(data.packages) ? data.packages : [];
  const results = await Promise.allSettled(packages.map((packageInfo) => (
    mergeObservedPiPackageCatalogEntry(uid, workspaceId, packageInfo && packageInfo.source)
  )));
  results
      .filter((result) => result.status === "rejected")
      .forEach((result) => logger.warn("skipped observed package catalog entry", {
        workspaceId,
        error: result.reason && result.reason.message ? result.reason.message : result.reason,
      }));
}

async function mergeObservedPiPackageCatalogEntry(uid, workspaceId, source) {
  if (!source) return null;
  const normalized = normalizePiPackageSource(source);
  const ref = piPackageCatalogCollection(uid).doc(piPackageCatalogDocId(normalized.identity));
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    transaction.set(ref, piPackageCatalogRecord(source, workspaceId, {
      includeCreatedAt: !snap.exists,
      incrementInstallCount: false,
    }), {merge: true});
  });
  return normalized;
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

async function requestRunnerPiAuthMaterialize(session, body) {
  return requestRunnerJson(session, "/pi/auth/materialize", {
    method: "POST",
    body,
    notFoundError: "runner_pi_auth_unsupported",
    notFoundStatus: 501,
    failureError: "pi_auth_materialize_failed",
    unavailableError: "runner_pi_auth_unavailable",
    timeoutMs: 30000,
  });
}

async function requestRunnerPiPackages(session) {
  return requestRunnerJson(session, "/pi/packages", {
    notFoundError: "runner_package_listing_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_read_failed",
    unavailableError: "runner_package_list_unavailable",
  });
}

async function requestRunnerPiPackageInstall(session, body) {
  return requestRunnerJson(session, "/pi/packages/install", {
    method: "POST",
    body,
    notFoundError: "runner_package_install_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_install_failed",
    unavailableError: "runner_package_install_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerPiPackageRemove(session, body) {
  return requestRunnerJson(session, "/pi/packages/remove", {
    method: "POST",
    body,
    notFoundError: "runner_package_remove_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_remove_failed",
    unavailableError: "runner_package_remove_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerPiPackageUpdate(session, body) {
  return requestRunnerJson(session, "/pi/packages/update", {
    method: "POST",
    body,
    notFoundError: "runner_package_update_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_update_failed",
    unavailableError: "runner_package_update_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerPiSkills(session) {
  return requestRunnerJson(session, "/pi/skills", {
    notFoundError: "runner_skill_listing_unsupported",
    notFoundStatus: 501,
    failureError: "pi_skill_list_failed",
    unavailableError: "runner_skill_list_unavailable",
  });
}

async function requestRunnerPiSkillSave(session, body) {
  return requestRunnerJson(session, "/pi/skills", {
    method: "POST",
    body,
    notFoundError: "runner_skill_save_unsupported",
    notFoundStatus: 501,
    failureError: "pi_skill_save_failed",
    unavailableError: "runner_skill_save_unavailable",
    timeoutMs: 30000,
  });
}

async function requestRunnerPiSkillDelete(session, body) {
  return requestRunnerJson(session, "/pi/skills/delete", {
    method: "POST",
    body,
    notFoundError: "runner_skill_delete_unsupported",
    notFoundStatus: 501,
    failureError: "pi_skill_delete_failed",
    unavailableError: "runner_skill_delete_unavailable",
    timeoutMs: 30000,
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

function normalizePiSkillPayload(payload) {
  return {
    name: normalizePiSkillName(payload && payload.name),
    description: normalizePiSkillDescription(payload && payload.description),
    content: normalizePiSkillContent(payload && (payload.content || payload.instructions)),
  };
}

function normalizePiSkillName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw httpError(400, "invalid_skill_name");
  }
  return name;
}

function normalizePiSkillDescription(value) {
  const description = String(value || "").trim();
  if (!description || description.length > 1024 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw httpError(400, "invalid_skill_description");
  }
  return description;
}

function normalizePiSkillContent(value) {
  const content = String(value || "").trim();
  if (!content || content.length > 128 * 1024 || /\u0000/.test(content)) {
    throw httpError(400, "invalid_skill_content");
  }
  return content;
}

function normalizePiPackageSource(value) {
  const source = String(value || "").trim();
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) {
    throw httpError(400, "invalid_package_source");
  }
  if (source.startsWith("npm:")) {
    return normalizeNpmPackageSource(source);
  }
  const gitSource = normalizeGitPackageSource(source);
  if (gitSource) return gitSource;
  throw httpError(400, "unsupported_package_source");
}

function normalizeNpmPackageSource(source) {
  const spec = source.slice("npm:".length).trim();
  const match = spec.match(/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([^\s/]+))?$/i);
  if (!match) throw httpError(400, "invalid_package_source");
  const name = match[1].toLowerCase();
  return {
    source,
    type: "npm",
    identity: `npm:${name}`,
    name,
    pinned: Boolean(match[2]),
  };
}

function normalizeGitPackageSource(source) {
  const parsed = parseGitPackageSource(source);
  if (!parsed) return null;
  return {
    source,
    type: "git",
    identity: `git:${parsed.host}/${parsed.path}`,
    host: parsed.host,
    path: parsed.path,
    pinned: Boolean(parsed.ref),
  };
}

function parseGitPackageSource(source) {
  const withoutGitPrefix = source.startsWith("git:") ? source.slice("git:".length) : source;
  const withoutGitPlus = withoutGitPrefix.startsWith("git+") ? withoutGitPrefix.slice("git+".length) : withoutGitPrefix;
  const [withoutRef, ref = ""] = withoutGitPlus.split("#");

  const sshMatch = withoutRef.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) return buildGitPackageSource(sshMatch[1], sshMatch[2], ref);

  const githubShorthand = withoutRef.match(/^github:([^/]+\/.+)$/);
  if (githubShorthand) return buildGitPackageSource("github.com", githubShorthand[1], ref);

  try {
    const parsed = new URL(withoutRef);
    if (parsed.username || parsed.password) throw httpError(400, "package_source_must_not_include_credentials");
    if (["git:", "https:", "ssh:"].includes(parsed.protocol)) {
      return buildGitPackageSource(parsed.hostname, parsed.pathname.replace(/^\/+/, ""), ref || parsed.hash.replace(/^#/, ""));
    }
  } catch (error) {
    if (error && error.status) throw error;
  }

  return null;
}

function buildGitPackageSource(host, gitPath, ref = "") {
  const normalizedHost = String(host || "").trim().toLowerCase();
  const normalizedPath = String(gitPath || "").trim().replace(/\.git$/, "");
  const parts = normalizeStoragePrefix(normalizedPath).split("/").filter(Boolean);
  if (!normalizedHost || !parts.length || parts.some((part) => part === "." || part === "..")) {
    throw httpError(400, "invalid_package_source");
  }
  if (!/^[a-z0-9.-]+$/i.test(normalizedHost)) throw httpError(400, "invalid_package_source");
  return {host: normalizedHost, path: parts.join("/"), ref: String(ref || "").trim()};
}

function piAuthDoc(uid) {
  return db.collection("users").doc(uid).collection("private").doc("piAuth");
}

function normalizePiAuthProviders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce((acc, [provider, credential]) => {
    const key = cleanName(provider);
    if (!key || !credential || typeof credential !== "object" || Array.isArray(credential)) return acc;
    acc[key] = normalizePlainObject(credential);
    return acc;
  }, {});
}

function normalizePiAuthEntries(value, providers = {}) {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value).reduce((acc, [id, entry]) => {
    const normalizedId = normalizePiAuthEntryId(id || entry && entry.id, {required: false});
    if (!normalizedId || !entry || typeof entry !== "object" || Array.isArray(entry)) return acc;
    const providerKey = normalizePiAuthStoredProviderKey(entry.providerKey || entry.provider || "");
    const credential = normalizePlainObject(entry.credential || entry.value || {});
    if (!providerKey || !Object.keys(credential).length) return acc;
    acc[normalizedId] = {
      id: normalizedId,
      providerKey,
      label: cleanName(entry.label || "") || piAuthProviderEntryFallbackLabel(providerKey),
      credential,
      createdAt: cleanName(entry.createdAt || ""),
    };
    return acc;
  }, {}) : {};

  Object.entries(providers || {}).forEach(([providerKey, credential]) => {
    const hasProviderEntry = Object.values(entries).some((entry) => entry.providerKey === providerKey);
    if (!hasProviderEntry) {
      const id = `legacy-${providerKey}`;
      entries[id] = {
        id,
        providerKey,
        label: piAuthProviderEntryFallbackLabel(providerKey),
        credential: normalizePlainObject(credential),
        createdAt: "",
      };
    }
  });
  return entries;
}

function normalizePiAuthSelection(value, entries = {}) {
  const selected = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.entries(selected).reduce((acc, [provider, entryId]) => {
    const providerKey = normalizePiAuthStoredProviderKey(provider);
    const normalizedEntryId = normalizePiAuthEntryId(entryId, {required: false});
    const entry = entries[normalizedEntryId];
    if (providerKey && entry && entry.providerKey === providerKey) acc[providerKey] = normalizedEntryId;
    return acc;
  }, {});
}

function normalizePiAuthEntryId(value, options = {}) {
  const id = cleanName(value);
  if (!id && options.required === false) return "";
  if (!id || id.length > 256 || /[^a-zA-Z0-9_.:-]/.test(id)) {
    throw httpError(400, "invalid_pi_auth_entry");
  }
  return id;
}

function buildPiAuthEntryId(providerKey) {
  return `${providerKey}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function defaultPiAuthEntryLabel(providerKey, entries) {
  const count = Object.values(entries || {}).filter((entry) => entry.providerKey === providerKey).length + 1;
  return count > 1 ? `${piAuthProviderEntryFallbackLabel(providerKey)} ${count}` : piAuthProviderEntryFallbackLabel(providerKey);
}

function piAuthProviderEntryFallbackLabel(providerKey) {
  return providerKey;
}

function normalizePlainObject(value) {
  return Object.entries(value || {}).reduce((acc, [key, item]) => {
    const cleanKey = cleanName(key);
    if (!cleanKey) return acc;
    const normalized = normalizePlainValue(item);
    if (normalized !== undefined) acc[cleanKey] = normalized;
    return acc;
  }, {});
}

function normalizePlainValue(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    return value.map(normalizePlainValue).filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") return normalizePlainObject(value);
  return undefined;
}

function normalizePiAuthProviderKey(value) {
  const provider = normalizePiAuthStoredProviderKey(value);
  if (!PI_AUTH_API_KEY_PROVIDERS.has(provider)) {
    throw httpError(400, "invalid_pi_auth_provider");
  }
  return provider;
}

function normalizePiAuthStoredProviderKey(value) {
  const provider = cleanName(value);
  if (!provider || provider.length > 256 || /[\u0000-\u001f\u007f]/.test(provider)) {
    throw httpError(400, "invalid_pi_auth_provider");
  }
  return provider;
}

function normalizePiAuthApiKey(value) {
  const key = String(value || "").trim();
  if (!key || /[\u0000-\u001f\u007f]/.test(key) || key.length > 4096) {
    throw httpError(400, "invalid_pi_auth_key");
  }
  return key;
}

function piPackageCatalogCollection(uid) {
  return db.collection("users").doc(uid).collection("piPackageCatalog");
}

function piPackageCatalogDocId(identity) {
  return encodeURIComponent(identity);
}

function piPackageCatalogRecord(source, workspaceId, options = {}) {
  const normalized = normalizePiPackageSource(source);
  const now = admin.firestore.FieldValue.serverTimestamp();
  return {
    identity: normalized.identity,
    type: normalized.type,
    source: normalized.source,
    updatedAt: now,
    lastWorkspaceId: cleanName(workspaceId || ""),
    installCount: admin.firestore.FieldValue.increment(options.incrementInstallCount ? 1 : 0),
    ...(options.includeCreatedAt ? {createdAt: now, favorite: false} : {}),
  };
}

async function mergePiPackageCatalogEntry(uid, workspaceId, source, options = {}) {
  const record = piPackageCatalogRecord(source, workspaceId, options);
  await piPackageCatalogCollection(uid).doc(piPackageCatalogDocId(record.identity)).set(record, {merge: true});
  return record;
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
