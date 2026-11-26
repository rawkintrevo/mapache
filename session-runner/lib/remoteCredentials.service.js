"use strict";

const crypto = require("node:crypto");

const TOKEN_AUDIENCE = "remote-credentials";
const TOKEN_TTL_SECONDS = 5 * 60;
const REFRESH_MARGIN_MS = 30 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_ENV_NAMES = new Set([
  "HOME", "PATH", "MCP_CONFIG", "OWNER_UID", "WORKSPACE_ID", "SESSION_ID",
  "SESSION_SHUTDOWN_TOKEN", "SESSION_BROWSER_TOKEN_SECRET", "MAPACHE_REMOTE_CREDENTIAL_BROKER_URL",
]);

function createRemoteCredentialsService(config = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetch || global.fetch;
  const now = dependencies.now || (() => Date.now());
  let cached = null;
  let inFlight = null;

  return Object.freeze({
    enabled: () => Boolean(config.remoteCredentialBrokerUrl && config.sessionBrowserTokenSecret &&
      config.workspaceId && config.sessionId && config.agentRuntimeGeneration),
    materialize: (options = {}) => materialize(options),
    authData: () => cached?.auth || {providers: {}, entries: {}},
    status: () => ({enabled: Boolean(config.remoteCredentialBrokerUrl), expiresAt: cached?.expiresAt || null}),
  });

  async function materialize(options = {}) {
    const force = options.force === true;
    if (!force && cached && Date.parse(cached.expiresAt || "") > now() + REFRESH_MARGIN_MS) return cached;
    if (inFlight) return inFlight;
    inFlight = fetchCredentials();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function fetchCredentials() {
    if (!config.remoteCredentialBrokerUrl) return null;
    if (typeof fetchImpl !== "function") throw serviceError("remote_credentials_unavailable", 503);
    const expiresAt = now() + TOKEN_TTL_SECONDS * 1000;
    const token = signRuntimeToken({
      bootId: config.agentRuntimeBootInstanceId,
      expiresAt,
      generation: config.agentRuntimeGeneration,
      issuedAt: now(),
      ownerUid: config.ownerUid,
      secret: config.sessionBrowserTokenSecret,
      sessionId: config.sessionId,
      workspaceId: config.workspaceId,
    });
    let response;
    try {
      response = await fetchImpl(config.remoteCredentialBrokerUrl, {
        method: "POST",
        headers: {authorization: `Bearer ${token}`, "content-type": "application/json"},
        body: "{}",
        redirect: "manual",
      });
    } catch (error) {
      throw serviceError("remote_credentials_unavailable", 503, error);
    }
    const body = await parseResponse(response);
    if (!response.ok) throw serviceError(body?.error || "remote_credentials_unavailable", response.status);
    validateResponse(body);
    if (String(body.generation || "") !== String(config.agentRuntimeGeneration || "")) {
      throw serviceError("remote_credentials_stale_generation", 409);
    }
    applyResponse(body);
    cached = body;
    return body;
  }

  function applyResponse(body) {
    const environment = body.environment && typeof body.environment === "object" && !Array.isArray(body.environment) ? body.environment : {};
    for (const [name, value] of Object.entries(environment)) {
      if (!SAFE_ENV_NAME.test(name) || RESERVED_ENV_NAMES.has(name)) throw serviceError("remote_credentials_invalid_response", 502);
      process.env[name] = value == null ? "" : String(value);
    }
    config.mcpConfigRaw = JSON.stringify(body.mcpConfig || {mcpServers: {}});
    config.googleMcpAccountEmail = String(environment.GOOGLE_MCP_ACCOUNT_EMAIL || config.googleMcpAccountEmail || "");
    config.googleMcpAccountName = String(environment.GOOGLE_MCP_ACCOUNT_NAME || config.googleMcpAccountName || "");
    config.googleMcpConnectionId = String(environment.GOOGLE_MCP_CONNECTION_ID || config.googleMcpConnectionId || "");
    config.googleMcpConnectionStatus = String(environment.GOOGLE_MCP_CONNECTION_STATUS || config.googleMcpConnectionStatus || "");
    config.googleMcpEnabledServices = String(environment.GOOGLE_MCP_ENABLED_SERVICES || config.googleMcpEnabledServices || "");
    config.googleMcpTokenRefreshUrl = String(environment.GOOGLE_MCP_TOKEN_REFRESH_URL || config.googleMcpTokenRefreshUrl || "");
  }

  async function parseResponse(response) {
    let text = "";
    if (response?.body && typeof response.body[Symbol.asyncIterator] === "function") {
      for await (const chunk of response.body) {
        text += Buffer.from(chunk).toString("utf8");
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw serviceError("remote_credentials_response_too_large", 502);
      }
    } else if (typeof response?.text === "function") {
      text = await response.text();
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw serviceError("remote_credentials_invalid_response", 502);
    }
  }
}

function validateResponse(body) {
  if (!body || body.ok !== true || !body.expiresAt || !Number.isFinite(Date.parse(body.expiresAt)) ||
      !body.auth || typeof body.auth !== "object" || !body.mcpConfig || typeof body.mcpConfig !== "object") {
    throw serviceError("remote_credentials_invalid_response", 502);
  }
}

function signRuntimeToken({secret, workspaceId, ownerUid, sessionId, generation, bootId, expiresAt, issuedAt} = {}) {
  const value = String(secret || "");
  if (!value) throw serviceError("remote_credentials_unavailable", 503);
  const iat = Math.floor(Number(issuedAt || Date.now()) / 1000);
  const payload = encode({
    aud: TOKEN_AUDIENCE,
    ...(bootId ? {boot: String(bootId)} : {}),
    exp: Math.floor(Number(expiresAt || Date.now() + TOKEN_TTL_SECONDS * 1000) / 1000),
    gen: String(generation || ""),
    iat,
    sid: String(sessionId || ""),
    uid: String(ownerUid || ""),
    wid: String(workspaceId || ""),
  });
  return `${payload}.${crypto.createHmac("sha256", value).update(payload).digest("base64url")}`;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function serviceError(code, status, cause) {
  const error = new Error(String(code));
  error.code = String(code);
  error.status = status;
  if (cause) error.cause = cause;
  return error;
}

module.exports = {
  MAX_RESPONSE_BYTES,
  TOKEN_AUDIENCE,
  TOKEN_TTL_SECONDS,
  createRemoteCredentialsService,
  signRuntimeToken,
};
