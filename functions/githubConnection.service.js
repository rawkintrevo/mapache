"use strict";

const crypto = require("crypto");
const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {cleanName, httpError} = require("./backendUtils.helpers");
const {
  cleanGithubNumericId,
  cleanGithubValue,
  createGithubClientService,
  normalizeGithubTokenPermissions,
} = require("./githubClient.service");

function createGithubConnectionService(dependencies = {}) {
  const admin = dependencies.admin || defaultAdmin;
  const db = dependencies.db || defaultDb;
  const githubClient = dependencies.githubClient || createGithubClientService(dependencies);
  const now = typeof dependencies.now === "function" ? dependencies.now : () => Date.now();

  return Object.freeze({
    createGithubConnectUrl: (uid, req) => createGithubConnectUrl(uid, req, {admin, db, githubClient, now}),
    disconnectGithub: (uid) => disconnectGithub(uid, {admin, db}),
    getGithubConnection: (uid) => getGithubConnection(uid, {db}),
    handleGithubCallback: (req, res) => handleGithubCallback(req, res, {admin, db, githubClient, now}),
    normalizeGithubConnectionStatus,
    normalizeGithubInstallationIds,
    normalizeGithubInstallationRecord,
    normalizeGithubReturnTo,
    requireGithubInstallationForUser: (uid, installationId) =>
      requireGithubInstallationForUser(uid, installationId, {db}),
  });
}

async function createGithubConnectUrl(uid, req, dependencies) {
  if (!dependencies.githubClient.isGithubOAuthConfigured()) {
    throw httpError(503, "github_oauth_not_configured");
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  await githubOAuthStateDoc(dependencies.db, state).set({
    uid,
    returnTo: normalizeGithubReturnTo(req.query.returnTo || req.get("referer") || req.get("origin")),
    createdAt: now,
    expiresAt: dependencies.admin.firestore.Timestamp.fromMillis(dependencies.now() + (10 * 60 * 1000)),
  });

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", dependencies.githubClient.getGithubOAuthClientId());
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", githubCallbackUrl(req));
  return {url: url.toString()};
}

async function handleGithubCallback(req, res, dependencies) {
  const code = cleanGithubValue(req.query.code);
  const state = cleanGithubValue(req.query.state);
  if (!code || !state) {
    res.status(400).send("Missing GitHub authorization code or state.");
    return;
  }
  if (!dependencies.githubClient.isGithubOAuthConfigured()) {
    res.status(503).send("GitHub OAuth is not configured.");
    return;
  }

  const stateRef = githubOAuthStateDoc(dependencies.db, state);
  const stateSnap = await stateRef.get();
  if (!stateSnap.exists) {
    res.status(400).send("GitHub authorization state expired or was not found.");
    return;
  }

  const stateData = stateSnap.data() || {};
  await stateRef.delete();
  const uid = cleanGithubValue(stateData.uid);
  if (!uid || githubStateExpired(stateData, dependencies.now)) {
    res.status(400).send("GitHub authorization state expired or was invalid.");
    return;
  }

  const tokenResponse = await dependencies.githubClient.exchangeGithubOAuthCode(code, githubCallbackUrl(req));
  const accessToken = cleanGithubToken(tokenResponse.access_token);
  if (!accessToken) {
    throw httpError(502, "github_oauth_token_failed");
  }

  const [githubUser, installations] = await Promise.all([
    dependencies.githubClient.requestGithubJson("https://api.github.com/user", accessToken, {
      failureError: "github_user_lookup_failed",
    }),
    dependencies.githubClient.listGithubUserInstallations(accessToken),
  ]);
  await storeGithubConnection(uid, githubUser, installations, dependencies);

  const redirectTo = cleanGithubValue(stateData.returnTo) || "/";
  res.status(302).set("Location", redirectTo).send("GitHub connected.");
}

async function getGithubConnection(uid, dependencies) {
  const [userSnap, installationSnap] = await Promise.all([
    githubUserDoc(dependencies.db, uid).get(),
    githubInstallationCollection(dependencies.db, uid).get(),
  ]);
  return normalizeGithubConnectionStatus(
      uid,
      userSnap.exists ? userSnap.data() || {} : null,
      installationSnap.docs.map((doc) => ({id: doc.id, data: doc.data() || {}})),
  );
}

async function disconnectGithub(uid, dependencies) {
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  const installationSnap = await githubInstallationCollection(dependencies.db, uid).get();
  const batch = dependencies.db.batch();
  batch.set(githubUserDoc(dependencies.db, uid), {
    firebaseUid: uid,
    connectionStatus: "disconnected",
    installationIds: [],
    updatedAt: now,
  }, {merge: true});
  installationSnap.docs.forEach((doc) => {
    batch.set(doc.ref, {
      installationStatus: "removed",
      removedAt: now,
      updatedAt: now,
    }, {merge: true});
  });
  await batch.commit();
  return getGithubConnection(uid, dependencies);
}

async function requireGithubInstallationForUser(uid, installationId, dependencies) {
  const [userSnap, installationDoc] = await Promise.all([
    githubUserDoc(dependencies.db, uid).get(),
    githubInstallationCollection(dependencies.db, uid).doc(installationId).get(),
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

async function storeGithubConnection(uid, githubUser, installations, dependencies) {
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  const installationIds = installations
      .map((installation) => cleanGithubNumericId(installation && installation.id))
      .filter(Boolean);
  const batch = dependencies.db.batch();
  batch.set(githubUserDoc(dependencies.db, uid), {
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
    batch.set(githubInstallationCollection(dependencies.db, uid).doc(installationId), {
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

function githubCallbackUrl(req) {
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${host}/api/github/callback`;
}

function githubStateExpired(value, now) {
  const expiresAt = value && value.expiresAt;
  return expiresAt && typeof expiresAt.toMillis === "function" && expiresAt.toMillis() < now();
}

function cleanGithubToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    throw httpError(502, "github_oauth_token_failed");
  }
  return token;
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

function normalizeGithubConnectionStatus(uid, userData, installationRecords) {
  const data = userData && typeof userData === "object" ? userData : {};
  const allowedInstallationIds = new Set(normalizeGithubInstallationIds(data.installationIds));
  const installations = (Array.isArray(installationRecords) ? installationRecords : [])
      .map((record) => normalizeGithubConnectionInstallation(
          uid,
          record && record.id,
          record && record.data,
          allowedInstallationIds,
      ))
      .filter(Boolean);
  const statusFromData = cleanName(data.connectionStatus).toLowerCase();
  let connectionStatus = statusFromData || (
    cleanGithubValue(data.githubLogin) || cleanGithubNumericId(data.githubUserId) ? "connected" : "not_connected"
  );
  if (connectionStatus === "disconnected") {
    connectionStatus = "not_connected";
  }
  if (connectionStatus === "connected" && installations.some((installation) => installation.status === "needs_reauth")) {
    connectionStatus = "needs_reauth";
  }

  return {
    connected: connectionStatus === "connected" || connectionStatus === "needs_reauth",
    connectionStatus,
    githubUserId: cleanGithubNumericId(data.githubUserId),
    githubLogin: cleanGithubValue(data.githubLogin),
    displayName: cleanGithubValue(data.displayName),
    avatarUrl: cleanGithubValue(data.avatarUrl),
    installationCount: installations.length,
    installationAccounts: installations,
  };
}

function normalizeGithubConnectionInstallation(uid, installationId, value, allowedInstallationIds) {
  const data = value && typeof value === "object" ? value : {};
  const normalizedInstallationId = cleanGithubNumericId(installationId || data.installationId);
  if (!normalizedInstallationId) {
    return null;
  }
  if (allowedInstallationIds.size && !allowedInstallationIds.has(normalizedInstallationId)) {
    return null;
  }

  const ownerUid = cleanGithubValue(data.ownerUid);
  if (ownerUid && ownerUid !== uid) {
    return null;
  }

  const status = cleanName(data.installationStatus).toLowerCase() || "active";
  if (status === "removed" || status === "disconnected") {
    return null;
  }

  return {
    installationId: normalizedInstallationId,
    accountLogin: cleanGithubValue(data.githubAccountLogin),
    accountType: cleanGithubValue(data.githubAccountType),
    repositorySelection: cleanGithubValue(data.repositorySelection),
    status,
  };
}

function githubUserDoc(db, uid) {
  return db.collection("githubUsers").doc(uid);
}

function githubInstallationCollection(db, uid) {
  return githubUserDoc(db, uid).collection("installations");
}

function githubOAuthStateDoc(db, state) {
  return db.collection("githubOAuthStates").doc(state);
}

module.exports = {
  createGithubConnectionService,
  normalizeGithubConnectionStatus,
  normalizeGithubInstallationIds,
  normalizeGithubInstallationRecord,
  normalizeGithubReturnTo,
};
