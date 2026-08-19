"use strict";

const logger = require("firebase-functions/logger");
const {
  admin,
  db,
} = require("./backendContext");
const {OPENAI_CODEX_PROVIDER} = require("./apiRoutes.helpers");
const {sessionHarnessId} = require("./agentAuth.service");
const {
  cleanName,
  httpError,
  normalizeStoragePrefix,
} = require("./backendUtils.helpers");

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_CODEX_DEVICE_VERIFICATION_URI = "https://auth.openai.com/codex/device";
const OPENAI_CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const OPENAI_CODEX_ACCOUNT_CLAIM_PATH = "https://api.openai.com/auth";
function createPiService(dependencies = {}) {
  return {
    completeOpenAiCodexDeviceCode: (uid, payload) => completeOpenAiCodexDeviceCode(uid, payload, dependencies),
    deleteWorkspaceSubagent: (uid, workspaceId, sessionId, payload) =>
      deleteWorkspaceSubagent(uid, workspaceId, sessionId, payload, dependencies),
    deleteWorkspaceSkill: (uid, workspaceId, sessionId, payload) =>
      deleteWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
    deletePiSkill: (uid, workspaceId, sessionId, payload) =>
      deleteWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
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
    saveWorkspaceSubagent: (uid, workspaceId, sessionId, payload) =>
      saveWorkspaceSubagent(uid, workspaceId, sessionId, payload, dependencies),
    saveWorkspaceSkill: (uid, workspaceId, sessionId, payload) =>
      saveWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
    savePiSkill: (uid, workspaceId, sessionId, payload) =>
      saveWorkspaceSkill(uid, workspaceId, sessionId, payload, dependencies),
    startOpenAiCodexDeviceCode,
    updatePiPackage: (uid, workspaceId, sessionId, payload) =>
      updatePiPackage(uid, workspaceId, sessionId, payload, dependencies),
  };
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

async function completeOpenAiCodexDeviceCode(uid, payload, dependencies = {}) {
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
  if (!dependencies.agentAuthService) throw new Error("Pi service requires an agentAuthService dependency.");
  await dependencies.agentAuthService.savePiAuthCredential(uid, OPENAI_CODEX_PROVIDER, {type: "oauth", ...oauth});
  return {status: "complete", ...(await dependencies.agentAuthService.getPiAuth(uid))};
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
  buildGitPackageSource,
  cleanOpenAiCodexDeviceField,
  createPiService,
  mergePiPackageCatalogEntry,
  normalizeGitPackageSource,
  normalizePiPackageSource,
  normalizePiSkillContent,
  normalizePiSkillDescription,
  normalizePiSkillName,
  normalizePiSkillPayload,
  openAiCodexAccountId,
  parseGitPackageSource,
  parseOpenAiCodexErrorCode,
  piPackageCatalogDocId,
  piPackageCatalogRecord,
  sessionSupportsWorkspaceSkills,
  sessionSupportsWorkspaceSubagents,
};
