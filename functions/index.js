"use strict";

const crypto = require("crypto");
const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const {
  admin,
  auth,
  db,
} = require("./backendContext");
const {
  DEFAULT_BUCKET,
  DEFAULT_CPU,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_IMAGE,
  DEFAULT_MEMORY,
  DEFAULT_REGION,
  DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS,
  GITHUB_APP_CLIENT_ID_SECRET,
  GITHUB_APP_CLIENT_SECRET_SECRET,
  GITHUB_APP_ID_SECRET,
  GITHUB_APP_PRIVATE_KEY_SECRET,
  INTERNAL_STORAGE_DIR,
  SESSION_BROWSER_ACCESS_TTL_MS,
  SESSION_RUNNER_SERVICE_ACCOUNT,
} = require("./backendConfig");
const {
  cleanName,
  cloudRunServiceName,
  defaultPreviewStaticRoot,
  httpError,
  isGoogleNotFound,
  latestTimestampMillis,
  normalizeServiceAccountEmail,
  normalizeStoragePrefix,
  positiveNumber,
  publicGoogleError,
  toClientDoc,
  userPath,
} = require("./backendUtils.helpers");
const {
  resolveRunnerImage,
  runnerImageCapabilities,
} = require("./runnerImages.helpers");
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

const workspaceService = createWorkspaceService({
  deleteSessionService,
  isConnectedGithubSourcePayload,
  normalizeConnectedGithubSourcePayload,
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
  listConnectedRepos,
  createGithubConnectUrl,
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
      await handleGithubCallback(req, res);
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

function isConnectedGithubSourcePayload(source) {
  const mode = cleanName(source && source.mode).toLowerCase();
  if (mode === "connected") {
    return true;
  }
  return Boolean(cleanGithubNumericId(source && source.installationId) || cleanGithubNumericId(source && source.repoId));
}

async function normalizeConnectedGithubSourcePayload(uid, source, options = {}) {
  if (!isGithubAppConfigured()) {
    throw httpError(503, "github_app_not_configured");
  }

  const installationId = normalizeGithubInstallationId(source.installationId);
  const expectedRepoId = cleanGithubNumericId(source.repoId);
  const expectedOwner = cleanGithubValue(source.owner).toLowerCase();
  const expectedRepo = cleanGithubValue(source.repo).toLowerCase();
  const requestedRepoUrl = cleanGithubValue(source.repoUrl || source.url);
  const installation = await requireGithubInstallationForUser(uid, installationId);
  const tokenResponse = await createGithubInstallationToken(installationId);
  const repos = await listGithubInstallationRepositories(installationId, tokenResponse.token);
  const matchedRepo = repos.find((repo) => {
    const liveRepoId = cleanGithubNumericId(repo && repo.id);
    const liveOwner = cleanGithubValue(repo && repo.owner && repo.owner.login).toLowerCase();
    const liveName = cleanGithubValue(repo && repo.name).toLowerCase();
    const liveCloneUrl = cleanGithubValue(repo && repo.clone_url);
    if (expectedRepoId && liveRepoId) {
      return expectedRepoId === liveRepoId;
    }
    if (expectedOwner && expectedRepo) {
      return expectedOwner === liveOwner && expectedRepo === liveName;
    }
    return Boolean(requestedRepoUrl && liveCloneUrl && requestedRepoUrl === liveCloneUrl);
  });

  if (!matchedRepo) {
    throw httpError(403, "github_connected_repo_forbidden");
  }

  const owner = cleanGithubValue(matchedRepo.owner && matchedRepo.owner.login);
  const repo = cleanGithubValue(matchedRepo.name);
  const cloneUrl = cleanGithubValue(matchedRepo.clone_url);
  const repoId = cleanGithubNumericId(matchedRepo.id);
  if (!owner || !repo || !cloneUrl || !repoId) {
    throw httpError(502, "github_connected_repo_invalid");
  }

  return {
    type: "github",
    mode: "connected",
    repoUrl: cloneUrl,
    owner,
    repo,
    requestedBranch: options.requestedBranch || cleanGithubValue(matchedRepo.default_branch) || null,
    requestedCommit: options.requestedCommit || null,
    visibility: matchedRepo.private ? "private" : "public",
    connection: {
      installationId,
      repoId,
      ownerUid: uid,
    },
  };
}

async function requireGithubInstallationForUser(uid, installationId) {
  const [userSnap, installationDoc] = await Promise.all([
    githubUserDoc(uid).get(),
    githubInstallationCollection(uid).doc(installationId).get(),
  ]);
  if (!installationDoc.exists) {
    throw httpError(403, "github_installation_forbidden");
  }

  const userData = userSnap.exists ? userSnap.data() || {} : {};
  const allowedInstallationIds = new Set(normalizeGithubInstallationIds(userData.installationIds));
  const installation = normalizeGithubInstallationRecord(uid, installationDoc.id, installationDoc.data(), allowedInstallationIds);
  if (!installation) {
    throw httpError(403, "github_installation_forbidden");
  }
  return installation;
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
    const tokenResponse = await createGithubInstallationToken(installationId);
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
  if (cleanName(session.sourceType) !== "github") {
    throw httpError(400, "not_git_workspace");
  }
  if (cleanName(session.sourceMode) !== "connected") {
    throw httpError(400, "github_pr_requires_connected_repo");
  }
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_open_pr_unavailable");

  const installationId = cleanGithubNumericId(session.sourceInstallationId);
  const owner = cleanGithubValue(session.sourceRepoOwner);
  const repo = cleanGithubValue(session.sourceRepoName);
  if (!installationId || !owner || !repo) {
    throw httpError(503, "github_pr_auth_unavailable");
  }

  const tokenResponse = await createGithubInstallationToken(installationId);
  const repository = await getGithubRepository(owner, repo, tokenResponse.token);
  const baseBranch = cleanGithubValue(repository.default_branch);
  if (!baseBranch) {
    throw httpError(502, "github_default_branch_unavailable");
  }

  const prepared = await requestRunnerGitOpenPr(session, {
    baseBranch,
    workingBranchName: buildWorkingBranchName(payload && payload.branchDescription),
    pushToken: tokenResponse.token,
    pushUsername: "x-access-token",
  });

  const template = await getGithubPullRequestTemplate(owner, repo, baseBranch, tokenResponse.token);
  const title = normalizePullRequestTitle(
      (payload && payload.title) || prepared.pullRequest && prepared.pullRequest.defaultTitle,
  );
  if (!title) {
    throw httpError(400, "missing_pull_request_title");
  }

  const body = Object.prototype.hasOwnProperty.call(payload || {}, "body") ?
    normalizePullRequestBody(payload.body) :
    template.body;
  const pullRequest = await createGithubPullRequest({
    owner,
    repo,
    token: tokenResponse.token,
    title,
    body,
    head: cleanGithubValue(prepared.pullRequest && prepared.pullRequest.branch),
    base: baseBranch,
    draft: Boolean(payload && payload.draft),
  });

  return {
    ...prepared,
    action: "open_pr",
    pullRequest: {
      number: Number(pullRequest.number || 0) || null,
      url: cleanGithubValue(pullRequest.html_url),
      title: cleanGithubValue(pullRequest.title) || title,
      draft: Boolean(pullRequest.draft),
      head: cleanGithubValue(pullRequest.head && pullRequest.head.ref) || cleanGithubValue(prepared.pullRequest && prepared.pullRequest.branch),
      base: cleanGithubValue(pullRequest.base && pullRequest.base.ref) || baseBranch,
      bodySource: template.source,
    },
  };
}

async function listConnectedRepos(uid) {
  if (!isGithubAppConfigured()) {
    throw httpError(503, "github_app_not_configured");
  }

  const [userSnap, installationSnap] = await Promise.all([
    githubUserDoc(uid).get(),
    githubInstallationCollection(uid).get(),
  ]);
  const userData = userSnap.exists ? userSnap.data() || {} : {};
  const connectionStatus = cleanName(userData.connectionStatus).toLowerCase();
  if (connectionStatus === "disconnected") {
    return {repos: []};
  }

  const allowedInstallationIds = new Set(normalizeGithubInstallationIds(userData.installationIds));
  const installations = installationSnap.docs
      .map((doc) => normalizeGithubInstallationRecord(uid, doc.id, doc.data(), allowedInstallationIds))
      .filter(Boolean);

  const repos = [];
  for (const installation of installations) {
    let tokenResponse;
    try {
      tokenResponse = await createGithubInstallationToken(installation.installationId);
    } catch (error) {
      if (isGithubInstallationNotFoundError(error)) {
        logger.warn("github installation missing during repo listing", {
          installationId: installation.installationId,
          uid,
        });
        continue;
      }
      throw error;
    }

    const storedRepos = await listStoredGithubInstallationRepositories(uid, installation.installationId);
    const liveRepos = await listGithubInstallationRepositories(
        installation.installationId,
        tokenResponse.token,
    );
    const repoMap = new Map();

    storedRepos.forEach((repo) => {
      repoMap.set(githubRepoMapKey(repo), repo);
    });

    liveRepos.forEach((repo) => {
      const normalizedRepo = normalizeGithubConnectedRepo(
          installation,
          repo,
          repoMap.get(githubRepoMapKey(repo)) || null,
          tokenResponse.repositorySelection,
      );
      if (normalizedRepo) {
        repos.push(normalizedRepo);
      }
    });
  }

  repos.sort((left, right) => {
    const leftKey = `${left.fullName || ""} ${left.installationId || ""}`.trim();
    const rightKey = `${right.fullName || ""} ${right.installationId || ""}`.trim();
    return leftKey.localeCompare(rightKey);
  });

  return {repos};
}

async function createGithubConnectUrl(uid, req) {
  if (!isGithubOAuthConfigured()) {
    throw httpError(503, "github_oauth_not_configured");
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const now = admin.firestore.FieldValue.serverTimestamp();
  await githubOAuthStateDoc(state).set({
    uid,
    returnTo: normalizeGithubReturnTo(req.query.returnTo || req.get("referer") || req.get("origin")),
    createdAt: now,
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + (10 * 60 * 1000)),
  });

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", githubClientId());
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", githubCallbackUrl(req));
  return {url: url.toString()};
}

async function handleGithubCallback(req, res) {
  const code = cleanGithubValue(req.query.code);
  const state = cleanGithubValue(req.query.state);
  if (!code || !state) {
    res.status(400).send("Missing GitHub authorization code or state.");
    return;
  }
  if (!isGithubOAuthConfigured()) {
    res.status(503).send("GitHub OAuth is not configured.");
    return;
  }

  const stateRef = githubOAuthStateDoc(state);
  const stateSnap = await stateRef.get();
  if (!stateSnap.exists) {
    res.status(400).send("GitHub authorization state expired or was not found.");
    return;
  }

  const stateData = stateSnap.data() || {};
  await stateRef.delete();
  const uid = cleanGithubValue(stateData.uid);
  if (!uid || githubStateExpired(stateData)) {
    res.status(400).send("GitHub authorization state expired or was invalid.");
    return;
  }

  const tokenResponse = await exchangeGithubOAuthCode(code, githubCallbackUrl(req));
  const accessToken = cleanGithubToken(tokenResponse.access_token);
  if (!accessToken) {
    throw httpError(502, "github_oauth_token_failed");
  }

  const [githubUser, installations] = await Promise.all([
    requestGithubJson("https://api.github.com/user", accessToken, {
      failureError: "github_user_lookup_failed",
    }),
    listGithubUserInstallations(accessToken),
  ]);
  await storeGithubConnection(uid, githubUser, installations);

  const redirectTo = cleanGithubValue(stateData.returnTo) || "/";
  res.status(302).set("Location", redirectTo).send("GitHub connected.");
}

function isGithubOAuthConfigured() {
  return Boolean(githubClientId() && githubClientSecret());
}

function githubCallbackUrl(req) {
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${host}/api/github/callback`;
}

function normalizeGithubReturnTo(value) {
  const fallback = "/";
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return fallback;
  }
  try {
    const url = new URL(rawValue);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return url.toString().slice(0, 512);
    }
  } catch (error) {
    return fallback;
  }
  return fallback;
}

function githubStateExpired(value) {
  const expiresAt = value && value.expiresAt;
  return expiresAt && typeof expiresAt.toMillis === "function" && expiresAt.toMillis() < Date.now();
}

async function exchangeGithubOAuthCode(code, redirectUri) {
  let response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "user-agent": "mapahce-functions",
      },
      body: JSON.stringify({
        client_id: githubClientId(),
        client_secret: githubClientSecret(),
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch (error) {
    throw httpError(502, "github_oauth_token_failed", error);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    logger.error("github oauth token exchange failed", {
      status: response.status,
      error: cleanGithubValue(data.error),
      errorDescription: cleanGithubValue(data.error_description),
    });
    throw httpError(502, "github_oauth_token_failed");
  }
  return data;
}

async function listGithubUserInstallations(token) {
  const installations = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL("https://api.github.com/user/installations");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const data = await requestGithubJson(url.toString(), token, {
      failureError: "github_user_installations_failed",
    });
    const pageInstallations = Array.isArray(data && data.installations) ? data.installations : [];
    installations.push(...pageInstallations);
    if (pageInstallations.length < 100) {
      break;
    }
  }
  return installations;
}

async function storeGithubConnection(uid, githubUser, installations) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const installationIds = installations
      .map((installation) => cleanGithubNumericId(installation && installation.id))
      .filter(Boolean);
  const batch = db.batch();
  batch.set(githubUserDoc(uid), {
    firebaseUid: uid,
    githubUserId: cleanGithubNumericId(githubUser && githubUser.id),
    githubLogin: cleanGithubValue(githubUser && githubUser.login),
    displayName: cleanGithubValue(githubUser && githubUser.name),
    avatarUrl: cleanGithubValue(githubUser && githubUser.avatar_url),
    connectionStatus: "connected",
    installationIds,
    updatedAt: now,
    lastSyncedAt: now,
    createdAt: now,
  }, {merge: true});

  installations.forEach((installation) => {
    const installationId = cleanGithubNumericId(installation && installation.id);
    if (!installationId) return;
    const account = installation.account || {};
    batch.set(githubInstallationCollection(uid).doc(installationId), {
      installationId,
      ownerUid: uid,
      githubAccountId: cleanGithubNumericId(account.id),
      githubAccountLogin: cleanGithubValue(account.login),
      githubAccountType: cleanGithubValue(account.type),
      repositorySelection: cleanGithubValue(installation.repository_selection),
      appId: cleanGithubNumericId(installation.app_id),
      permissionSet: normalizeGithubTokenPermissions(installation.permissions),
      installationStatus: "active",
      webhookConfigured: true,
      updatedAt: now,
      lastSyncedAt: now,
      createdAt: now,
      removedAt: null,
    }, {merge: true});
  });

  await batch.commit();
}

async function createGithubInstallationToken(installationId) {
  if (!isGithubAppConfigured()) {
    throw httpError(503, "github_app_not_configured");
  }

  const normalizedInstallationId = normalizeGithubInstallationId(installationId);
  const appJwt = createGithubAppJwt();
  const response = await requestGithubInstallationToken(normalizedInstallationId, appJwt);

  return {
    installationId: normalizedInstallationId,
    token: cleanGithubToken(response.token),
    expiresAt: cleanGithubTimestamp(response.expires_at),
    permissions: normalizeGithubTokenPermissions(response.permissions),
    repositorySelection: cleanGithubValue(response.repository_selection),
  };
}

function isGithubAppConfigured() {
  return Boolean(normalizeGithubAppId(githubAppId()) && normalizeGithubPrivateKey());
}

function normalizeGithubInstallationId(value) {
  const installationId = String(value || "").trim();
  if (!/^\d+$/.test(installationId)) {
    throw httpError(400, "invalid_github_installation_id");
  }
  return installationId;
}

function normalizeGithubAppId(value) {
  return String(value || "").trim();
}

function normalizeGithubPrivateKey() {
  const key = String(githubPrivateKey() || "").trim();
  return key ? key.replace(/\\n/g, "\n") : "";
}

function createGithubAppJwt() {
  const appId = normalizeGithubAppId(githubAppId());
  const privateKey = normalizeGithubPrivateKey();
  if (!appId || !privateKey) {
    throw httpError(503, "github_app_not_configured");
  }

  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const expiresAt = issuedAt + (9 * 60);
  const header = {alg: "RS256", typ: "JWT"};
  const payload = {
    iat: issuedAt,
    exp: expiresAt,
    iss: appId,
  };
  const encodedHeader = encodeJwtSegment(header);
  const encodedPayload = encodeJwtSegment(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  try {
    const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey)
        .toString("base64url");
    return `${signingInput}.${signature}`;
  } catch (error) {
    throw httpError(502, "github_app_jwt_failed", error);
  }
}

function encodeJwtSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function githubAppId() {
  return secretValue(GITHUB_APP_ID_SECRET) || process.env.GITHUB_APP_ID || "";
}

function githubClientId() {
  return secretValue(GITHUB_APP_CLIENT_ID_SECRET) || process.env.GITHUB_APP_CLIENT_ID || "";
}

function githubClientSecret() {
  return secretValue(GITHUB_APP_CLIENT_SECRET_SECRET) || process.env.GITHUB_APP_CLIENT_SECRET || "";
}

function githubPrivateKey() {
  return secretValue(GITHUB_APP_PRIVATE_KEY_SECRET) || process.env.GITHUB_APP_PRIVATE_KEY || "";
}

function secretValue(secret) {
  try {
    return secret.value();
  } catch (error) {
    return "";
  }
}

async function requestGithubInstallationToken(installationId, appJwt) {
  let response;
  try {
    response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${appJwt}`,
        "user-agent": "mapahce-functions",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch (error) {
    throw httpError(502, "github_installation_token_failed", error);
  }

  if (response.status === 404) {
    throw httpError(404, "github_installation_not_found");
  }

  if (!response.ok) {
    const errorBody = await safeReadGithubErrorBody(response);
    logger.error("github installation token request failed", {
      installationId,
      status: response.status,
      body: errorBody,
    });
    throw httpError(502, "github_installation_token_failed");
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw httpError(502, "github_installation_token_failed", error);
  }

  if (!data || typeof data.token !== "string" || !data.token.trim()) {
    throw httpError(502, "github_installation_token_failed");
  }

  return data;
}

async function getGithubRepository(owner, repo, token) {
  return requestGithubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token, {
    failureError: "github_repository_lookup_failed",
  });
}

async function getGithubPullRequestTemplate(owner, repo, baseBranch, token) {
  const directPaths = [
    ".github/pull_request_template.md",
    ".github/pull_request_template.txt",
    "docs/pull_request_template.md",
    "docs/pull_request_template.txt",
    "pull_request_template.md",
    "pull_request_template.txt",
  ];
  for (const templatePath of directPaths) {
    const content = await getGithubRepositoryFile(owner, repo, templatePath, baseBranch, token);
    if (content) {
      return {body: content, source: `repository_template:${templatePath}`};
    }
  }

  const templateDirs = [
    ".github/PULL_REQUEST_TEMPLATE",
    "docs/PULL_REQUEST_TEMPLATE",
    "PULL_REQUEST_TEMPLATE",
  ];
  for (const directoryPath of templateDirs) {
    const entries = await listGithubRepositoryDirectory(owner, repo, directoryPath, baseBranch, token);
    const templateEntry = (entries || [])
        .filter((entry) => entry && entry.type === "file" && /\.(md|txt)$/i.test(entry.name || ""))
        .sort((left, right) => cleanGithubValue(left.path).localeCompare(cleanGithubValue(right.path)))[0];
    if (!templateEntry || !templateEntry.path) {
      continue;
    }
    const content = await getGithubRepositoryFile(owner, repo, templateEntry.path, baseBranch, token);
    if (content) {
      return {body: content, source: `repository_template:${cleanGithubValue(templateEntry.path)}`};
    }
  }

  return {
    body: defaultPullRequestBody(),
    source: "fallback_template",
  };
}

async function getGithubRepositoryFile(owner, repo, filePath, ref, token) {
  let data;
  try {
    data = await requestGithubJson(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeGithubContentPath(filePath)}?ref=${encodeURIComponent(ref)}`,
        token,
        {failureError: "github_repository_file_lookup_failed"},
    );
  } catch (error) {
    if (error && error.status === 404) {
      return "";
    }
    throw error;
  }

  if (!data || Array.isArray(data) || cleanGithubValue(data.type) !== "file") {
    return "";
  }
  if (cleanGithubValue(data.encoding) !== "base64") {
    return "";
  }

  try {
    return Buffer.from(String(data.content || "").replace(/\n/g, ""), "base64").toString("utf8");
  } catch (error) {
    throw httpError(502, "github_repository_file_decode_failed", error);
  }
}

async function listGithubRepositoryDirectory(owner, repo, directoryPath, ref, token) {
  try {
    const data = await requestGithubJson(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeGithubContentPath(directoryPath)}?ref=${encodeURIComponent(ref)}`,
        token,
        {failureError: "github_repository_directory_lookup_failed"},
    );
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error && error.status === 404) {
      return [];
    }
    throw error;
  }
}

async function createGithubPullRequest({owner, repo, token, title, body, head, base, draft}) {
  return requestGithubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, token, {
    method: "POST",
    body: {
      title,
      head,
      base,
      body,
      draft: Boolean(draft),
    },
    failureError: "github_pull_request_create_failed",
  });
}

async function requestGithubJson(url, token, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "mapahce-functions",
        "x-github-api-version": "2022-11-28",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    throw httpError(502, options.failureError || "github_request_failed", error);
  }

  const data = await response.json().catch(() => ({}));
  if (response.status === 404) {
    throw httpError(404, cleanGithubApiMessage(data) || options.failureError || "github_request_failed");
  }
  if (!response.ok) {
    const status = response.status === 422 || response.status === 409 ? 400 : 502;
    throw httpError(status, cleanGithubApiMessage(data) || options.failureError || "github_request_failed");
  }
  return data;
}

function cleanGithubApiMessage(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const message = cleanGithubValue(value.message || "");
  const detail = Array.isArray(value.errors) ? value.errors.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return cleanGithubValue(entry);
    }
    return cleanGithubValue(entry.message || entry.code || entry.field || entry.resource);
  }).filter(Boolean)[0] : "";
  return [message, detail].filter(Boolean).join(": ");
}

function encodeGithubContentPath(value) {
  return String(value || "").split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
}

function defaultPullRequestBody() {
  return [
    "## Summary",
    "- ",
    "",
    "## Testing",
    "- Not run (fill in)",
  ].join("\n");
}

async function safeReadGithubErrorBody(response) {
  try {
    const text = await response.text();
    return cleanGithubErrorBody(text);
  } catch (error) {
    return "";
  }
}

function cleanGithubErrorBody(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function cleanGithubToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    throw httpError(502, "github_installation_token_failed");
  }
  return token;
}

function cleanGithubTimestamp(value) {
  const timestamp = String(value || "").trim();
  return timestamp || "";
}

function normalizeGithubTokenPermissions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value).reduce((result, [key, permission]) => {
    const normalizedKey = cleanGithubValue(key);
    const normalizedPermission = cleanGithubValue(permission);
    if (normalizedKey && normalizedPermission) {
      result[normalizedKey] = normalizedPermission;
    }
    return result;
  }, {});
}

function cleanGithubValue(value) {
  return String(value || "").trim().slice(0, 256);
}

function cleanGithubNumericId(value) {
  const normalized = String(value == null ? "" : value).trim();
  return /^\d+$/.test(normalized) ? normalized : "";
}

function githubUserDoc(uid) {
  return db.collection("githubUsers").doc(uid);
}

function githubInstallationCollection(uid) {
  return githubUserDoc(uid).collection("installations");
}

function githubInstallationRepoCollection(uid, installationId) {
  return githubInstallationCollection(uid).doc(installationId).collection("repositories");
}

function githubOAuthStateDoc(state) {
  return db.collection("githubOAuthStates").doc(state);
}

function normalizeGithubInstallationIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
      .map(cleanGithubNumericId)
      .filter(Boolean);
}

function normalizeGithubInstallationRecord(uid, installationId, value, allowedInstallationIds) {
  const normalizedInstallationId = cleanGithubNumericId(installationId || value && value.installationId);
  if (!normalizedInstallationId) {
    return null;
  }
  if (allowedInstallationIds.size && !allowedInstallationIds.has(normalizedInstallationId)) {
    return null;
  }

  const ownerUid = cleanGithubValue(value && value.ownerUid);
  if (ownerUid && ownerUid !== uid) {
    return null;
  }

  const status = cleanName(value && value.installationStatus).toLowerCase();
  if (status && status !== "active") {
    return null;
  }

  return {
    installationId: normalizedInstallationId,
    githubAccountLogin: cleanGithubValue(value && value.githubAccountLogin),
    repositorySelection: cleanGithubValue(value && value.repositorySelection),
  };
}

async function listStoredGithubInstallationRepositories(uid, installationId) {
  const snap = await githubInstallationRepoCollection(uid, installationId).get();
  return snap.docs
      .map((doc) => normalizeStoredGithubRepositoryRecord(uid, installationId, doc.id, doc.data()))
      .filter(Boolean);
}

function normalizeStoredGithubRepositoryRecord(uid, installationId, docId, value) {
  const ownerUid = cleanGithubValue(value && value.ownerUid);
  if (ownerUid && ownerUid !== uid) {
    return null;
  }
  if (value && value.accessible === false) {
    return null;
  }

  const normalizedInstallationId = cleanGithubNumericId(value && value.installationId) || installationId;
  if (normalizedInstallationId !== installationId) {
    return null;
  }

  const repoId = cleanGithubNumericId(docId || value && value.repoId);
  const owner = cleanGithubValue(value && (value.ownerLogin || value.owner));
  const name = cleanGithubValue(value && value.name);
  const fullName = cleanGithubValue(value && (value.fullName || (owner && name ? `${owner}/${name}` : "")));
  if (!repoId && !fullName) {
    return null;
  }

  return {
    repoId,
    owner,
    name,
    fullName,
    defaultBranch: cleanGithubValue(value && value.defaultBranch),
    private: Boolean(value && value.private),
    cloneUrl: cleanGithubValue(value && value.cloneUrl),
    htmlUrl: cleanGithubValue(value && value.htmlUrl),
  };
}

async function listGithubInstallationRepositories(installationId, token) {
  const repositories = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL("https://api.github.com/installation/repositories");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    let response;
    try {
      response = await fetch(url, {
        headers: {
          "accept": "application/vnd.github+json",
          "authorization": `Bearer ${token}`,
          "user-agent": "mapahce-functions",
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch (error) {
      throw httpError(502, "github_connected_repos_failed", error);
    }

    if (response.status === 404) {
      throw httpError(404, "github_installation_not_found");
    }

    if (!response.ok) {
      const errorBody = await safeReadGithubErrorBody(response);
      logger.error("github installation repository list failed", {
        installationId,
        status: response.status,
        body: errorBody,
      });
      throw httpError(502, "github_connected_repos_failed");
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw httpError(502, "github_connected_repos_failed", error);
    }

    const pageRepos = Array.isArray(data && data.repositories) ? data.repositories : null;
    if (!pageRepos) {
      throw httpError(502, "github_connected_repos_failed");
    }

    repositories.push(...pageRepos);
    if (pageRepos.length < 100) {
      break;
    }
  }

  return repositories;
}

function githubRepoMapKey(value) {
  const repoId = cleanGithubNumericId(value && (value.id || value.repoId));
  if (repoId) {
    return `id:${repoId}`;
  }

  const owner = cleanGithubValue(value && (value.owner && value.owner.login || value.ownerLogin || value.owner));
  const name = cleanGithubValue(value && (value.name || value.repo));
  if (owner && name) {
    return `name:${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  const fullName = cleanGithubValue(value && (value.full_name || value.fullName));
  return fullName ? `name:${fullName.toLowerCase()}` : "";
}

function normalizeGithubConnectedRepo(installation, liveRepo, storedRepo, repositorySelection) {
  const owner = cleanGithubValue(
      liveRepo && liveRepo.owner && liveRepo.owner.login ||
      storedRepo && storedRepo.owner ||
      installation && installation.githubAccountLogin,
  );
  const name = cleanGithubValue(liveRepo && liveRepo.name || storedRepo && storedRepo.name);
  const fullName = cleanGithubValue(
      liveRepo && liveRepo.full_name ||
      storedRepo && storedRepo.fullName ||
      (owner && name ? `${owner}/${name}` : ""),
  );
  if (!owner || !name || !fullName) {
    return null;
  }

  const cloneUrl = cleanGithubValue(
      liveRepo && liveRepo.clone_url ||
      storedRepo && storedRepo.cloneUrl ||
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`,
  );
  const repoUrl = cleanGithubValue(
      liveRepo && liveRepo.html_url ||
      storedRepo && storedRepo.htmlUrl ||
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );
  const isPrivate = Boolean(liveRepo && liveRepo.private != null ? liveRepo.private : storedRepo && storedRepo.private);

  return {
    repoId: cleanGithubNumericId(liveRepo && liveRepo.id || storedRepo && storedRepo.repoId),
    installationId: installation.installationId,
    owner,
    name,
    fullName,
    defaultBranch: cleanGithubValue(
        liveRepo && liveRepo.default_branch ||
        storedRepo && storedRepo.defaultBranch ||
        "main",
    ),
    private: isPrivate,
    visibility: cleanGithubValue(liveRepo && liveRepo.visibility || (isPrivate ? "private" : "public")),
    cloneUrl,
    repoUrl,
    repositorySelection: cleanGithubValue(
        repositorySelection || installation.repositorySelection,
    ),
  };
}

function isGithubInstallationNotFoundError(error) {
  return Boolean(error && error.status === 404 && error.publicMessage === "github_installation_not_found");
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

function piHomeStoragePrefix(uid) {
  const cleanUid = cleanName(uid);
  return cleanUid ? `users/${cleanUid}/.mapahce-internal/pi-home` : "";
}

function piSessionDir(sessionId) {
  const cleanSessionId = cleanName(sessionId);
  return cleanSessionId ? `/root/.pi/agent/mapache-sessions/${cleanSessionId}` : "/root/.pi/agent/mapache-sessions/session";
}

function piSessionStoragePrefix(workspaceStoragePrefix, sessionId) {
  const cleanPrefix = String(workspaceStoragePrefix || "").replace(/^\/+|\/+$/g, "");
  const cleanSessionId = cleanName(sessionId);
  if (!cleanPrefix || !cleanSessionId) return "";
  return `${cleanPrefix}/${INTERNAL_STORAGE_DIR}/sessions/${cleanSessionId}/pi-session`;
}

async function provisionSessionService(workspace, sessionRef, session) {
  try {
    const client = await auth.getClient();
    const parent = `projects/${await getProjectId()}/locations/${session.region}`;
    const url = `https://run.googleapis.com/v2/${parent}/services?serviceId=${session.serviceId}`;
    const body = await buildCloudRunService(workspace, session);
    const response = await client.request({url, method: "POST", data: body});
    await waitForOperation(client, response.data);
    await setPublicInvoker(client, `${parent}/services/${session.serviceId}`);
    const service = await getCloudRunService(
        client,
        `${parent}/services/${session.serviceId}`,
    );
    await sessionRef.update({
      status: "running",
      serviceUrl: service.uri || null,
      lastError: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await sessionRef.update({
      status: "provision_failed",
      lastError: publicGoogleError(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function patchSessionService(sessionRef, session, options = {}) {
  if (!session.serviceName) {
    await sessionRef.update({
      status: "needs_service",
      lastError: "This session has no Cloud Run serviceName yet.",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }

  try {
    const serviceAccount = requireRunnerServiceAccount(session);
    const client = await auth.getClient();
    const url = `https://run.googleapis.com/v2/${session.serviceName}`;
    const body = {
      template: {
        serviceAccount,
        containers: [{
          image: session.image,
          resources: {limits: resourceLimits(session.resources)},
          env: options.restart ? await sessionRunnerEnv(session, {
            restartNonce: Date.now().toString(),
          }) : undefined,
        }],
      },
    };
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

async function deleteSessionService(sessionRef, session, options = {}) {
  if (!session.serviceName) {
    await markSessionStopped(sessionRef, session, options.reason);
    return true;
  }

  try {
    await requestRunnerShutdown(session);
    const client = await auth.getClient();
    const url = `https://run.googleapis.com/v2/${session.serviceName}`;
    const response = await client.request({url, method: "DELETE"});
    await waitForOperation(client, response.data);
    await markSessionStopped(sessionRef, session, options.reason);
    return true;
  } catch (error) {
    if (isGoogleNotFound(error)) {
      await markSessionStopped(sessionRef, session, options.reason);
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

async function buildCloudRunService(workspace, session) {
  const serviceAccount = requireRunnerServiceAccount(session);
  return {
    template: {
      serviceAccount,
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
          }),
        ],
      }],
    },
  };
}

function runnerServiceAccountValue() {
  return normalizeServiceAccountEmail(
      process.env.SESSION_RUNNER_SERVICE_ACCOUNT ||
      SESSION_RUNNER_SERVICE_ACCOUNT.value() ||
      "",
  );
}

function requireRunnerServiceAccount(session = {}) {
  const serviceAccount = runnerServiceAccountValue() ||
    normalizeServiceAccountEmail(session.serviceAccount || "");
  if (!serviceAccount) {
    throw new Error("Set SESSION_RUNNER_SERVICE_ACCOUNT to a least-privilege Cloud Run runtime service account before provisioning sessions.");
  }
  return serviceAccount;
}

async function sessionRunnerEnv(session, options = {}) {
  const capabilities = session.capabilities || runnerImageCapabilities(session.image);
  const terminal = terminalCommandEnv(session);
  const env = [
    {name: "FIREBASE_PROJECT_ID", value: process.env.GCLOUD_PROJECT || ""},
    {name: "OWNER_UID", value: session.ownerUid || ""},
    {name: "WORKSPACE_ID", value: session.workspaceId || ""},
    {name: "SESSION_ID", value: session.runnerSessionId || ""},
    {name: "STORAGE_BUCKET", value: session.workspaceStorageBucket || DEFAULT_BUCKET || ""},
    {name: "STORAGE_PREFIX", value: session.workspaceStoragePrefix || ""},
    {name: "PI_HOME_STORAGE_BUCKET", value: session.piHomeStorageBucket || DEFAULT_BUCKET || ""},
    {name: "PI_HOME_STORAGE_PREFIX", value: session.piHomeStoragePrefix || piHomeStoragePrefix(session.ownerUid)},
    {name: "PI_SESSION_DIR", value: session.piSessionDir || piSessionDir(session.runnerSessionId || session.id || "")},
    {name: "PI_SESSION_STORAGE_BUCKET", value: session.piSessionStorageBucket || session.workspaceStorageBucket || DEFAULT_BUCKET || ""},
    {
      name: "PI_SESSION_STORAGE_PREFIX",
      value: session.piSessionStoragePrefix || piSessionStoragePrefix(session.workspaceStoragePrefix, session.runnerSessionId || session.id || ""),
    },
    {name: "PI_SESSION_JSONL_PATH", value: session.piSessionJsonlPath || ""},
    {name: "PI_CODING_AGENT_DIR", value: "/root/.pi/agent"},
    {name: "SESSION_NAME", value: cleanName(session.name || "Terminal session")},
    {name: "TERMINAL_COMMAND", value: terminal.command},
    {name: "TERMINAL_ARGS", value: JSON.stringify(terminal.args)},
    {name: "TERMINAL_KIND", value: cleanName(session.terminalKind || "pi") || "pi"},
    {name: "SESSION_SHUTDOWN_TOKEN", value: session.shutdownToken || ""},
    {name: "SESSION_BROWSER_TOKEN_SECRET", value: session.browserAccessTokenSecret || ""},
    {name: "WORKSPACE_SOURCE_TYPE", value: cleanName(session.sourceType || "blank") || "blank"},
    {name: "WORKSPACE_SYNC_POLICY_MODE", value: cleanName(session.syncPolicyMode || "blank") || "blank"},
    {name: "WORKSPACE_SYNC_POLICY_EXCLUDE", value: stringifySyncPolicyExclude(session.syncPolicyExclude)},
    {name: "RUNNER_CAPABILITIES", value: JSON.stringify(capabilities)},
    options.restartNonce ? {name: "RESTART_NONCE", value: options.restartNonce} : null,
  ];

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

    env.push(...await buildGithubAuthEnv(session));
  }

  return env.filter(Boolean);
}

function terminalCommandEnv(session) {
  if (isShellSession(session)) {
    return {command: "bash", args: ["-l"]};
  }
  return {
    command: "pi",
    args: ["--session-dir", session.piSessionDir || piSessionDir(session.runnerSessionId || session.id || ""), "-c"],
  };
}

async function buildGithubAuthEnv(session) {
  if (cleanName(session.sourceType) !== "github") {
    return [];
  }

  if (cleanName(session.sourceMode) !== "connected") {
    return [];
  }

  const installationId = cleanGithubNumericId(session.sourceInstallationId);
  if (!installationId) {
    throw httpError(503, "github_auth_unavailable");
  }

  const tokenResponse = await createGithubInstallationToken(installationId);
  const env = [
    {name: "GITHUB_AUTOMATION_USERNAME", value: "x-access-token"},
    {name: "GITHUB_AUTOMATION_TOKEN", value: tokenResponse.token},
  ];

  if (cleanName(session.sourceVisibility) === "private") {
    env.push(
        {name: "GITHUB_CLONE_USERNAME", value: "x-access-token"},
        {name: "GITHUB_CLONE_TOKEN", value: tokenResponse.token},
    );
  }

  return env;
}

function sessionSourceMetadata(workspace) {
  const source = workspace && workspace.source ? workspace.source : {type: "blank"};
  if (source.type !== "github") {
    return {sourceType: "blank"};
  }

  return {
    sourceType: "github",
    sourceMode: cleanName(source.mode || "public"),
    sourceVisibility: cleanName(source.visibility || "public"),
    sourceRepoUrl: cleanName(source.repoUrl || ""),
    sourceRepoOwner: cleanName(source.owner || ""),
    sourceRepoName: cleanName(source.repo || ""),
    sourceRequestedBranch: cleanName(source.requestedBranch || ""),
    sourceRequestedCommit: cleanName(source.requestedCommit || ""),
    sourceResolvedBranch: cleanName(source.resolvedBranch || ""),
    sourceResolvedCommit: cleanName(source.resolvedCommit || ""),
    sourceInstallationId: cleanGithubNumericId(source.connection && source.connection.installationId),
    sourceRepoId: cleanGithubNumericId(source.connection && source.connection.repoId),
  };
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

function stringifySyncPolicyExclude(value) {
  try {
    return JSON.stringify(Array.isArray(value) ? value : []);
  } catch (error) {
    return "[]";
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

async function waitForOperation(client, operation) {
  if (!operation || !operation.name) return;
  const url = `https://run.googleapis.com/v2/${operation.name}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await client.request({url, method: "GET"});
    if (response.data && response.data.done) {
      if (response.data.error) {
        throw new Error(JSON.stringify(response.data.error));
      }
      return response.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Cloud Run operation timed out.");
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

function buildWorkingBranchName(value) {
  const slug = normalizeBranchDescription(value);
  return slug ? `mapache/${slug}` : "";
}

function normalizeBranchDescription(value) {
  return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
}

function normalizePullRequestTitle(value) {
  return String(value || "").trim().slice(0, 256);
}

function normalizePullRequestBody(value) {
  return String(value || "").trim().slice(0, 20000);
}
