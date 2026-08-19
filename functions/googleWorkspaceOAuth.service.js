"use strict";

const crypto = require("crypto");
const {httpError} = require("./backendUtils.helpers");
const {
  getGoogleWorkspaceService,
  googleWorkspaceScopeSelection,
  googleWorkspaceServiceCatalog,
} = require("./googleWorkspace.catalog");

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const refreshLocks = new Map();

function createGoogleWorkspaceOAuthService(dependencies = {}) {
  const config = {
    clientId: String(dependencies.clientId || process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim(),
    clientSecret: String(dependencies.clientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim(),
    redirectUri: String(dependencies.redirectUri || process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim(),
    encryptionKey: dependencies.encryptionKey || process.env.GOOGLE_OAUTH_ENCRYPTION_KEY || "",
  };
  const fetchImpl = dependencies.fetchImpl || fetch;
  const connections = dependencies.connectionsService;
  const state = dependencies.stateService;
  if (!connections || !state) throw new Error("Google OAuth service requires connection and state services.");
  return {
    listGoogleWorkspaceServices: () => googleWorkspaceServiceCatalog(),
    startGoogleConnection: (uid, workspaceId, payload) => startGoogleConnection(uid, workspaceId, payload, {
      ...dependencies, config, connections, state,
    }),
    completeGoogleConnection: (query) => completeGoogleConnection(query, {
      ...dependencies, config, connections, state, fetchImpl,
    }),
    refreshGoogleConnection: (uid, connectionId) => refreshGoogleConnection(uid, connectionId, {
      ...dependencies, config, connections, fetchImpl,
    }),
    revokeGoogleConnection: (uid, connectionId) => revokeGoogleConnection(uid, connectionId, {
      ...dependencies, config, connections, fetchImpl,
    }),
    decryptRefreshToken: (value) => decryptSecret(value, config.encryptionKey),
    encryptRefreshToken: (value) => encryptSecret(value, config.encryptionKey),
  };
}

async function startGoogleConnection(uid, workspaceId, payload = {}, dependencies) {
  if (typeof dependencies.requireWorkspace === "function") await dependencies.requireWorkspace(uid, workspaceId);
  const selection = normalizeSelection(payload);
  requireConfigured(dependencies.config, "start");
  const attemptId = crypto.randomUUID();
  const stateToken = dependencies.state.issue({
    uid,
    workspaceId,
    attemptId,
    serviceKeys: selection.serviceKeys,
  });
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set("client_id", dependencies.config.clientId);
  url.searchParams.set("redirect_uri", dependencies.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("scope", selection.scopes.join(" "));
  url.searchParams.set("state", stateToken);
  return {
    attemptId,
    authorizationUrl: url.toString(),
    redirectUri: dependencies.config.redirectUri,
    serviceKeys: selection.serviceKeys,
    accessLevel: selection.accessLevel,
  };
}

async function completeGoogleConnection(query = {}, dependencies) {
  const stateToken = cleanQueryValue(query.state);
  const code = cleanQueryValue(query.code);
  if (query.error) return {status: 400, html: callbackPage(false, "Google authorization was not completed.")};
  if (!stateToken || !code) throw httpError(400, "invalid_google_oauth_callback");
  const context = dependencies.state.consume(stateToken);
  requireConfigured(dependencies.config, "callback");
  const tokenData = await exchangeAuthorizationCode(code, dependencies);
  const identity = await fetchGoogleIdentity(tokenData.access_token, dependencies.fetchImpl);
  const selectedScopes = context.serviceKeys.length ? googleWorkspaceScopeSelection(context.serviceKeys, "read") : [];
  const connectionId = `google-${crypto.createHash("sha256").update(`${context.uid}:${identity.sub}`).digest("hex").slice(0, 32)}`;
  const refreshToken = tokenData.refresh_token || await existingRefreshToken(context.uid, connectionId, dependencies);
  if (!refreshToken) throw httpError(502, "google_refresh_token_missing");
  const grantedScopes = String(tokenData.scope || "").split(/\s+/).filter(Boolean).slice(0, 100);
  const metadata = {
    connectionId,
    googleSubject: cleanQueryValue(identity.sub),
    email: cleanQueryValue(identity.email).toLowerCase(),
    displayName: cleanQueryValue(identity.name || identity.email),
    grantedScopes: grantedScopes.length ? grantedScopes : selectedScopes,
    enabledServices: context.serviceKeys,
    oauthClientRef: dependencies.config.clientId,
    status: "connected",
    lastRefreshedAt: new Date().toISOString(),
  };
  const encryptedCredentials = encryptSecret(refreshToken, dependencies.config.encryptionKey);
  let summary;
  try {
    await dependencies.connections.getGoogleConnection(context.uid, connectionId, {includePrivate: true});
    summary = await dependencies.connections.updateGoogleConnection(context.uid, connectionId, metadata, encryptedCredentials);
  } catch (error) {
    if (error.publicMessage !== "google_connection_not_found") throw error;
    summary = await dependencies.connections.createGoogleConnection(context.uid, metadata, encryptedCredentials);
  }
  await dependencies.connections.bindGoogleWorkspaceConnection(context.uid, context.workspaceId, {
    connectionId,
    enabledServices: context.serviceKeys,
  });
  return {status: 200, html: callbackPage(true, "Google account connected."), connection: summary};
}

async function refreshGoogleConnection(uid, connectionId, dependencies) {
  const lockKey = `${uid}:${connectionId}`;
  if (refreshLocks.has(lockKey)) return refreshLocks.get(lockKey);
  const operation = refreshGoogleConnectionOnce(uid, connectionId, dependencies)
      .finally(() => refreshLocks.delete(lockKey));
  refreshLocks.set(lockKey, operation);
  return operation;
}

async function refreshGoogleConnectionOnce(uid, connectionId, dependencies) {
  requireConfigured(dependencies.config, "refresh");
  const connection = await dependencies.connections.getGoogleConnection(uid, connectionId, {includePrivate: true});
  const refreshToken = decryptSecret(connection.encryptedCredentials, dependencies.config.encryptionKey);
  if (!refreshToken) throw httpError(409, "google_refresh_token_missing");
  const response = await dependencies.fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      client_id: dependencies.config.clientId,
      client_secret: dependencies.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    if (data.error === "invalid_grant") {
      await dependencies.connections.updateGoogleConnection(uid, connectionId, {status: "reconnect_required"});
      throw httpError(409, "google_connection_reconnect_required");
    }
    throw httpError(502, "google_token_refresh_failed");
  }
  const nextCredentials = data.refresh_token ? encryptSecret(data.refresh_token, dependencies.config.encryptionKey) : connection.encryptedCredentials;
  const summary = await dependencies.connections.updateGoogleConnection(uid, connectionId, {
    status: "connected",
    lastRefreshedAt: new Date().toISOString(),
  }, nextCredentials);
  return {accessToken: String(data.access_token || ""), expiresIn: Number(data.expires_in || 0), connection: summary};
}

async function revokeGoogleConnection(uid, connectionId, dependencies) {
  const connection = await dependencies.connections.getGoogleConnection(uid, connectionId, {includePrivate: true});
  const refreshToken = decryptSecret(connection.encryptedCredentials, dependencies.config.encryptionKey);
  if (refreshToken) {
    const response = await dependencies.fetchImpl(`${GOOGLE_REVOCATION_URL}?token=${encodeURIComponent(refreshToken)}`, {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
    });
    if (!response.ok && response.status !== 400) throw httpError(502, "google_revoke_failed");
  }
  return dependencies.connections.updateGoogleConnection(uid, connectionId, {
    status: "revoked",
  }, null);
}

async function exchangeAuthorizationCode(code, dependencies) {
  const response = await dependencies.fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      client_id: dependencies.config.clientId,
      client_secret: dependencies.config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: dependencies.config.redirectUri,
    }),
  });
  const data = await safeJson(response);
  if (!response.ok || !data.access_token) throw httpError(502, "google_oauth_token_exchange_failed");
  return data;
}

async function fetchGoogleIdentity(accessToken, fetchImpl) {
  const response = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: {Authorization: `Bearer ${accessToken}`},
  });
  const data = await safeJson(response);
  if (!response.ok || !data.sub || !data.email) throw httpError(502, "google_identity_lookup_failed");
  return data;
}

async function existingRefreshToken(uid, connectionId, dependencies) {
  try {
    const existing = await dependencies.connections.getGoogleConnection(uid, connectionId, {includePrivate: true});
    return decryptSecret(existing.encryptedCredentials, dependencies.config.encryptionKey);
  } catch (error) {
    return "";
  }
}

function normalizeSelection(payload) {
  const serviceKeys = Array.isArray(payload.serviceKeys) ? [...new Set(payload.serviceKeys.map((key) => String(key || "").trim().toLowerCase()))] : [];
  if (!serviceKeys.length || serviceKeys.some((key) => !getGoogleWorkspaceService(key))) throw httpError(400, "invalid_google_service_selection");
  const accessLevel = String(payload.accessLevel || "read").trim().toLowerCase();
  if (accessLevel !== "read" && accessLevel !== "write") throw httpError(400, "invalid_google_access_level");
  if (accessLevel === "write" && serviceKeys.some((key) => !getGoogleWorkspaceService(key).writeScopes.length)) {
    throw httpError(400, "google_write_access_unsupported");
  }
  return {serviceKeys, accessLevel, scopes: googleWorkspaceScopeSelection(serviceKeys, accessLevel)};
}

function requireConfigured(config, action) {
  const missingEncryptionKey = action !== "start" && !config.encryptionKey;
  if (!config.clientId || !config.clientSecret || !config.redirectUri || missingEncryptionKey) {
    throw httpError(503, `google_oauth_not_configured_${action}`);
  }
}

function encryptSecret(value, secret) {
  const key = encryptionKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptSecret(value, secret) {
  if (!value || typeof value !== "object" || value.algorithm !== "aes-256-gcm") return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(value.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    throw httpError(500, "google_credential_decrypt_failed");
  }
}

function encryptionKey(secret) {
  const text = String(secret || "");
  if (!text) throw httpError(500, "google_credential_encryption_unavailable");
  return crypto.createHash("sha256").update(text).digest();
}

async function safeJson(response) {
  return response.json().catch(() => ({}));
}

function cleanQueryValue(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text)) return "";
  return text;
}

function callbackPage(success, message) {
  const title = success ? "Google connected" : "Google connection failed";
  const safeMessage = String(message).replace(/[&<>\"']/g, (character) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[character]));
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${safeMessage}</p><script>window.close();</script>`;
}

module.exports = {
  GOOGLE_AUTHORIZATION_URL,
  GOOGLE_REVOCATION_URL,
  GOOGLE_TOKEN_URL,
  callbackPage,
  createGoogleWorkspaceOAuthService,
  decryptSecret,
  encryptSecret,
  normalizeSelection,
};
