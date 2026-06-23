"use strict";

const crypto = require("crypto");
const logger = require("firebase-functions/logger");
const {
  admin,
  db,
} = require("./backendContext");
const {OPENAI_CODEX_PROVIDER} = require("./apiRoutes.helpers");
const {
  cleanName,
  httpError,
  normalizeStoragePrefix,
} = require("./backendUtils.helpers");

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

function createPiService(dependencies = {}) {
  return {
    completeOpenAiCodexDeviceCode,
    deletePiAuthEntry,
    deletePiAuthProvider,
    deleteWorkspaceSubagent: (uid, workspaceId, sessionId, payload) =>
      deleteWorkspaceSubagent(uid, workspaceId, sessionId, payload, dependencies),
    deleteWorkspaceSkill: (uid, workspaceId, sessionId, payload) =>
      deleteWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
    deletePiSkill: (uid, workspaceId, sessionId, payload) =>
      deleteWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
    getPiAuth,
    handleOpenAiCodexOAuthCallback,
    installPiPackage: (uid, workspaceId, sessionId, payload) =>
      installPiPackage(uid, workspaceId, sessionId, payload, dependencies),
    listPiPackages: (uid, workspaceId, sessionId) =>
      listPiPackages(uid, workspaceId, sessionId, dependencies),
    listWorkspaceSubagents: (uid, workspaceId, sessionId) =>
      listWorkspaceSubagents(uid, workspaceId, sessionId, dependencies),
    listWorkspaceSkills: (uid, workspaceId, sessionId) =>
      listWorkspaceSkills(uid, workspaceId, sessionId, dependencies),
    listPiSkills: (uid, workspaceId, sessionId) =>
      listWorkspaceSkills(uid, workspaceId, sessionId, dependencies),
    removePiPackage: (uid, workspaceId, sessionId, payload) =>
      removePiPackage(uid, workspaceId, sessionId, payload, dependencies),
    savePiAuthProvider,
    saveWorkspaceSubagent: (uid, workspaceId, sessionId, payload) =>
      saveWorkspaceSubagent(uid, workspaceId, sessionId, payload, dependencies),
    saveWorkspaceSkill: (uid, workspaceId, sessionId, payload) =>
      saveWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
    savePiSkill: (uid, workspaceId, sessionId, payload) =>
      saveWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
    saveSessionPiAuthSelection: (uid, workspaceId, sessionId, payload) =>
      saveSessionPiAuthSelection(uid, workspaceId, sessionId, payload, dependencies),
    startOpenAiCodexDeviceCode,
    startOpenAiCodexOAuth,
    updatePiPackage: (uid, workspaceId, sessionId, payload) =>
      updatePiPackage(uid, workspaceId, sessionId, payload, dependencies),
  };
}

async function getPiAuth(uid) {
  const {providers, entries} = await readCompatiblePiAuthState(uid);
  return {providers, entries};
}

async function savePiAuthProvider(uid, provider, payload) {
  const providerKey = normalizePiAuthProviderKey(provider);
  const apiKey = normalizePiAuthApiKey(payload && payload.key);
  await savePiAuthCredential(uid, providerKey, {type: "api_key", key: apiKey}, payload && payload.label);
  return getPiAuth(uid);
}

async function deletePiAuthProvider(uid, provider) {
  const providerKey = normalizePiAuthStoredProviderKey(provider);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const state = await readCompatiblePiAuthTransactionState(transaction, uid);
    const current = state.providers;
    const entries = state.entries;
    const nextAuth = removePiAuthProvider(current, entries, providerKey);
    writeCompatiblePiAuthMaps(transaction, state, {
      providers: nextAuth.providers,
      entries: nextAuth.entries,
      updatedAt: now,
      createdAt: now,
    });
  });
  return getPiAuth(uid);
}

async function deletePiAuthEntry(uid, entryId) {
  const normalizedEntryId = normalizePiAuthEntryId(entryId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const state = await readCompatiblePiAuthTransactionState(transaction, uid);
    const providers = state.providers;
    const entries = state.entries;
    const nextAuth = removePiAuthEntry(providers, entries, normalizedEntryId);
    if (!nextAuth) return;
    writeCompatiblePiAuthMaps(transaction, state, {
      providers: nextAuth.providers,
      entries: nextAuth.entries,
      updatedAt: now,
      createdAt: now,
    });
  });
  return getPiAuth(uid);
}

function removePiAuthProvider(providers, entries, providerKey) {
  const nextProviders = {...providers};
  delete nextProviders[providerKey];
  const nextEntries = Object.entries(entries).reduce((acc, [id, entry]) => {
    if (entry.providerKey !== providerKey) acc[id] = entry;
    return acc;
  }, {});
  return {providers: nextProviders, entries: nextEntries};
}

function removePiAuthEntry(providers, entries, entryId) {
  const entry = entries[entryId];
  if (!entry) return null;
  const nextEntries = {...entries};
  delete nextEntries[entryId];
  const latestForProvider = Object.values(nextEntries)
      .filter((item) => item.providerKey === entry.providerKey)
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
  const nextProviders = {...providers};
  if (latestForProvider) nextProviders[entry.providerKey] = latestForProvider.credential;
  else delete nextProviders[entry.providerKey];
  return {providers: nextProviders, entries: nextEntries};
}

function writePiAuthMaps(transaction, ref, snap, fields) {
  const payload = {
    providers: fields.providers,
    entries: fields.entries,
    updatedAt: fields.updatedAt,
  };
  if (snap.exists) {
    transaction.update(ref, payload);
    return;
  }
  transaction.set(ref, {...payload, createdAt: fields.createdAt});
}

async function savePiAuthCredential(uid, providerKey, credential, label = "") {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const state = await readCompatiblePiAuthTransactionState(transaction, uid);
    const current = state.providers;
    const entries = state.entries;
    const cleanCredential = normalizePlainObject(credential);
    const entryId = buildPiAuthEntryId(providerKey);
    const createdAt = new Date().toISOString();
    writeCompatiblePiAuthMaps(transaction, state, {
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
      createdAt: now,
    });
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
    id: data.id_token || "",
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    accountId,
  };
}

async function saveSessionPiAuthSelection(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const harnessId = sessionHarnessId(session);
  if (!["pi", "codex"].includes(harnessId)) {
    throw httpError(400, "auth_selection_unsupported");
  }
  const piAuth = await getPiAuth(uid);
  const selection = {
    harness: harnessId,
    providers: normalizePiAuthSelection(payload && payload.selection && payload.selection.providers ? payload.selection.providers : payload && payload.selection, piAuth.entries),
  };
  await sessionSnap.ref.set({
    authSelection: selection,
    piAuthSelection: selection.providers,
    authSelectionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});

  let materialized = {ok: true, appliedToRunner: false, providerCount: Object.keys(selection.providers).length};
  if (session.serviceUrl && session.shutdownToken) {
    materialized = await requestRunnerAuthMaterialize(session, {selection}, dependencies);
  }
  return {ok: true, selection, materialized};
}

async function installPiPackage(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = normalizePiPackageSource(payload.source);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_install_unsupported");
  const result = await requestRunnerPiPackageInstall(session, {source: packageSource.source}, dependencies);
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

async function removePiPackage(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = normalizePiPackageSource(payload.source);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_remove_unsupported");
  return requestRunnerPiPackageRemove(session, {source: packageSource.source}, dependencies);
}

async function updatePiPackage(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const packageSource = payload.source ? normalizePiPackageSource(payload.source) : null;
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_update_unsupported");
  return requestRunnerPiPackageUpdate(session, packageSource ? {source: packageSource.source} : {}, dependencies);
}

async function listPiPackages(uid, workspaceId, sessionId, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!session.shutdownToken) throw httpError(501, "runner_package_listing_unsupported");
  const data = await requestRunnerPiPackages(session, dependencies);
  await recordObservedPiPackages(uid, workspaceId, data).catch((error) => {
    logger.warn("observed package catalog update failed", {workspaceId, sessionId, error: error.message || error});
  });
  const knownPackages = await listKnownPiPackages(uid, data).catch((error) => {
    logger.warn("known package catalog read failed", {workspaceId, sessionId, error: error.message || error});
    return [];
  });
  return {...data, knownPackages};
}

async function listWorkspaceSkills(uid, workspaceId, sessionId, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSkills(session)) throw httpError(501, "runner_skill_listing_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_listing_unsupported");
  return requestRunnerWorkspaceSkills(session, dependencies);
}

async function saveWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const skill = normalizePiSkillPayload(payload);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSkills(session)) throw httpError(501, "runner_skill_save_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_save_unsupported");
  return requestRunnerWorkspaceSkillSave(session, skill, dependencies);
}

async function deleteWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const skillName = normalizePiSkillName(payload.name);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSkills(session)) throw httpError(501, "runner_skill_delete_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_skill_delete_unsupported");
  return requestRunnerWorkspaceSkillDelete(session, {name: skillName}, dependencies);
}

async function listWorkspaceSubagents(uid, workspaceId, sessionId, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSubagents(session)) throw httpError(501, "runner_subagent_listing_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_subagent_listing_unsupported");
  return requestRunnerWorkspaceSubagents(session, dependencies);
}

async function saveWorkspaceSubagent(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const subagent = normalizeWorkspaceSubagentPayload(payload);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSubagents(session)) throw httpError(501, "runner_subagent_save_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_subagent_save_unsupported");
  return requestRunnerWorkspaceSubagentSave(session, subagent, dependencies);
}

async function deleteWorkspaceSubagent(uid, workspaceId, sessionId, payload, dependencies = {}) {
  await requireWorkspaceDependency(dependencies, uid, workspaceId);
  const {sessionSnap} = await requireSessionDependency(dependencies, uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  const subagentName = normalizeWorkspaceSubagentName(payload.name);
  if (!session.serviceUrl) throw httpError(409, "no_active_session");
  if (!sessionSupportsWorkspaceSubagents(session)) throw httpError(501, "runner_subagent_delete_unsupported");
  if (!session.shutdownToken) throw httpError(501, "runner_subagent_delete_unsupported");
  return requestRunnerWorkspaceSubagentDelete(session, {name: subagentName}, dependencies);
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

async function requestRunnerAuthMaterialize(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/auth/materialize", {
    method: "POST",
    body,
    notFoundError: "runner_auth_unsupported",
    notFoundStatus: 501,
    failureError: "auth_materialize_failed",
    unavailableError: "runner_auth_unavailable",
    timeoutMs: 30000,
  });
}

async function requestRunnerPiPackages(session, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/pi/packages", {
    notFoundError: "runner_package_listing_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_read_failed",
    unavailableError: "runner_package_list_unavailable",
  });
}

async function requestRunnerPiPackageInstall(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/pi/packages/install", {
    method: "POST",
    body,
    notFoundError: "runner_package_install_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_install_failed",
    unavailableError: "runner_package_install_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerPiPackageRemove(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/pi/packages/remove", {
    method: "POST",
    body,
    notFoundError: "runner_package_remove_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_remove_failed",
    unavailableError: "runner_package_remove_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerPiPackageUpdate(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/pi/packages/update", {
    method: "POST",
    body,
    notFoundError: "runner_package_update_unsupported",
    notFoundStatus: 501,
    failureError: "pi_package_update_failed",
    unavailableError: "runner_package_update_unavailable",
    timeoutMs: 120000,
  });
}

async function requestRunnerWorkspaceSkills(session, dependencies = {}) {
  return requestRunnerWorkspaceSkillRouteFallback(dependencies, session, {
    legacyRoutePath: "/pi/skills",
    routePath: "/skills",
    requestOptions: {
      notFoundError: "runner_skill_listing_unsupported",
      notFoundStatus: 501,
      failureError: "pi_skill_list_failed",
      unavailableError: "runner_skill_list_unavailable",
    },
  });
}

async function requestRunnerWorkspaceSkillSave(session, body, dependencies = {}) {
  return requestRunnerWorkspaceSkillRouteFallback(dependencies, session, {
    legacyRoutePath: "/pi/skills",
    routePath: "/skills",
    requestOptions: {
      method: "POST",
      body,
      notFoundError: "runner_skill_save_unsupported",
      notFoundStatus: 501,
      failureError: "pi_skill_save_failed",
      unavailableError: "runner_skill_save_unavailable",
      timeoutMs: 30000,
    },
  });
}

async function requestRunnerWorkspaceSkillDelete(session, body, dependencies = {}) {
  return requestRunnerWorkspaceSkillRouteFallback(dependencies, session, {
    legacyRoutePath: "/pi/skills/delete",
    routePath: "/skills/delete",
    requestOptions: {
      method: "POST",
      body,
      notFoundError: "runner_skill_delete_unsupported",
      notFoundStatus: 501,
      failureError: "pi_skill_delete_failed",
      unavailableError: "runner_skill_delete_unavailable",
      timeoutMs: 30000,
    },
  });
}

async function requestRunnerWorkspaceSubagents(session, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/subagents", {
    notFoundError: "runner_subagent_listing_unsupported",
    notFoundStatus: 501,
    failureError: "subagent_list_failed",
    unavailableError: "runner_subagent_list_unavailable",
  });
}

async function requestRunnerWorkspaceSubagentSave(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/subagents", {
    method: "POST",
    body,
    notFoundError: "runner_subagent_save_unsupported",
    notFoundStatus: 501,
    failureError: "subagent_save_failed",
    unavailableError: "runner_subagent_save_unavailable",
    timeoutMs: 30000,
  });
}

async function requestRunnerWorkspaceSubagentDelete(session, body, dependencies = {}) {
  return requestRunnerJsonDependency(dependencies, session, "/subagents/delete", {
    method: "POST",
    body,
    notFoundError: "runner_subagent_delete_unsupported",
    notFoundStatus: 501,
    failureError: "subagent_delete_failed",
    unavailableError: "runner_subagent_delete_unavailable",
    timeoutMs: 30000,
  });
}

function sessionSupportsWorkspaceSkills(session = {}) {
  return ["pi", "codex"].includes(sessionHarnessId(session));
}

function sessionSupportsWorkspaceSubagents(session = {}) {
  return ["pi", "codex"].includes(sessionHarnessId(session));
}

function sessionHarnessId(session = {}) {
  const harnessId = String(session.harnessId || "").trim().toLowerCase();
  if (harnessId) return harnessId;
  const terminalKind = String(session.terminalKind || "").trim().toLowerCase();
  if (terminalKind) return terminalKind;
  const imageKey = String(session.imageKey || "").trim().toLowerCase();
  if (imageKey.startsWith("pi-")) return "pi";
  if (imageKey.startsWith("codex-")) return "codex";
  const image = String(session.image || "").trim().toLowerCase();
  if (/session-runner:pi-/.test(image)) return "pi";
  if (/session-runner:codex-/.test(image)) return "codex";
  return "shell";
}

async function requestRunnerWorkspaceSkillRouteFallback(dependencies, session, {
  routePath,
  legacyRoutePath,
  requestOptions,
}) {
  try {
    return await requestRunnerJsonDependency(dependencies, session, routePath, requestOptions);
  } catch (error) {
    if (error?.status !== (requestOptions.notFoundStatus || 501) || error?.publicMessage !== requestOptions.notFoundError) {
      throw error;
    }
    return requestRunnerJsonDependency(dependencies, session, legacyRoutePath, requestOptions);
  }
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

function normalizeWorkspaceSubagentPayload(payload) {
  return {
    name: normalizeWorkspaceSubagentName(payload && payload.name),
    description: normalizeWorkspaceSubagentDescription(payload && payload.description),
    instructions: normalizeWorkspaceSubagentInstructions(payload && (payload.instructions || payload.content || payload.developerInstructions)),
  };
}

function normalizeWorkspaceSubagentName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw httpError(400, "invalid_subagent_name");
  }
  return name;
}

function normalizeWorkspaceSubagentDescription(value) {
  const description = String(value || "").trim();
  if (!description || description.length > 1024 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw httpError(400, "invalid_subagent_description");
  }
  return description;
}

function normalizeWorkspaceSubagentInstructions(value) {
  const instructions = String(value || "").trim();
  if (!instructions || instructions.length > 128 * 1024 || /\u0000/.test(instructions)) {
    throw httpError(400, "invalid_subagent_content");
  }
  return instructions;
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

function agentAuthDoc(uid) {
  return db.collection("users").doc(uid).collection("private").doc("agentAuth");
}

function legacyPiAuthDoc(uid) {
  return db.collection("users").doc(uid).collection("private").doc("piAuth");
}

async function readCompatiblePiAuthState(uid) {
  const refs = compatiblePiAuthDocRefs(uid);
  const [agentSnap, legacySnap] = await Promise.all([refs.agent.get(), refs.legacy.get()]);
  return mergeCompatiblePiAuthState(
      agentSnap.exists ? agentSnap.data() : {},
      legacySnap.exists ? legacySnap.data() : {},
  );
}

async function readCompatiblePiAuthTransactionState(transaction, uid) {
  const refs = compatiblePiAuthDocRefs(uid);
  const [agentSnap, legacySnap] = await Promise.all([
    transaction.get(refs.agent),
    transaction.get(refs.legacy),
  ]);
  return {
    refs,
    snaps: {
      agent: agentSnap,
      legacy: legacySnap,
    },
    ...mergeCompatiblePiAuthState(
        agentSnap.exists ? agentSnap.data() : {},
        legacySnap.exists ? legacySnap.data() : {},
    ),
  };
}

function compatiblePiAuthDocRefs(uid) {
  return {
    agent: agentAuthDoc(uid),
    legacy: legacyPiAuthDoc(uid),
  };
}

function mergeCompatiblePiAuthState(agentData = {}, legacyData = {}) {
  const legacyProviders = normalizePiAuthProviders(legacyData.providers);
  const agentProviders = normalizePiAuthProviders(agentData.providers);
  const providers = {...legacyProviders, ...agentProviders};
  const legacyEntries = normalizePiAuthEntries(legacyData.entries, legacyProviders);
  const agentEntries = normalizePiAuthEntries(agentData.entries, agentProviders);
  return {
    providers,
    entries: normalizePiAuthEntries({...legacyEntries, ...agentEntries}, providers),
  };
}

function writeCompatiblePiAuthMaps(transaction, state, fields) {
  writePiAuthMaps(transaction, state.refs.agent, state.snaps.agent, fields);
  writePiAuthMaps(transaction, state.refs.legacy, state.snaps.legacy, fields);
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

async function requireWorkspaceDependency(dependencies, uid, workspaceId) {
  if (typeof dependencies.requireWorkspace !== "function") {
    throw new Error("Pi service requires a requireWorkspace dependency.");
  }
  return dependencies.requireWorkspace(uid, workspaceId);
}

async function requireSessionDependency(dependencies, uid, workspaceId, sessionId) {
  if (typeof dependencies.requireSession !== "function") {
    throw new Error("Pi service requires a requireSession dependency.");
  }
  return dependencies.requireSession(uid, workspaceId, sessionId);
}

async function requestRunnerJsonDependency(dependencies, session, routePath, options = {}) {
  if (typeof dependencies.requestRunnerJson !== "function") {
    throw new Error("Pi service requires a requestRunnerJson dependency.");
  }
  return dependencies.requestRunnerJson(session, routePath, options);
}

module.exports = {
  appendQuery,
  buildGitPackageSource,
  cleanOpenAiCodexDeviceField,
  createPiService,
  mergePiPackageCatalogEntry,
  normalizeGitPackageSource,
  mergeCompatiblePiAuthState,
  normalizeOpenAiCodexReturnTo,
  normalizePiAuthApiKey,
  normalizePiAuthEntries,
  normalizePiAuthEntryId,
  normalizePiAuthProviderKey,
  normalizePiAuthProviders,
  normalizePiAuthSelection,
  normalizePiAuthStoredProviderKey,
  normalizePiPackageSource,
  normalizePiSkillContent,
  normalizePiSkillDescription,
  normalizePiSkillName,
  normalizePiSkillPayload,
  normalizePlainObject,
  openAiCodexAccountId,
  parseGitPackageSource,
  parseOpenAiCodexErrorCode,
  piPackageCatalogDocId,
  piPackageCatalogRecord,
  removePiAuthEntry,
  removePiAuthProvider,
  sessionSupportsWorkspaceSkills,
  sessionSupportsWorkspaceSubagents,
  writePiAuthMaps,
};
