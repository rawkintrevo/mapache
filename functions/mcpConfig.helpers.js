"use strict";

const {cleanName, httpError} = require("./backendUtils.helpers");

const MAX_MCP_SERVERS = 20;
const MAX_MCP_NAME_LENGTH = 64;
const MAX_MCP_ARG_LENGTH = 512;
const MAX_MCP_ENV_VALUE_LENGTH = 4096;
const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MCP_LIFECYCLES = new Set(["", "lazy", "eager", "keep-alive"]);
const MCP_AUTH_MODES = new Set(["none", "oauth2", "bearer_env"]);
const MCP_ENV_REF_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

function normalizeMcpConfigPayload(payload = {}) {
  const sourceServers = payload.mcpServers && typeof payload.mcpServers === "object" && !Array.isArray(payload.mcpServers) ?
    Object.entries(payload.mcpServers).map(([name, server]) => ({name, ...server})) :
    Array.isArray(payload.servers) ? payload.servers : [];

  const mcpServers = {};
  for (const source of sourceServers.slice(0, MAX_MCP_SERVERS + 1)) {
    if (Object.keys(mcpServers).length >= MAX_MCP_SERVERS) throw httpError(400, "too_many_mcp_servers");
    const server = normalizeMcpServer(source);
    mcpServers[server.name] = server.config;
  }

  return {
    version: 1,
    mcpServers,
  };
}

function normalizeMcpServer(source = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw httpError(400, "invalid_mcp_server");
  }

  const name = cleanMcpName(source.name);
  const command = cleanText(source.command, MAX_MCP_ARG_LENGTH);
  const url = cleanText(source.url, MAX_MCP_ENV_VALUE_LENGTH);
  if (!command && !url) throw httpError(400, "missing_mcp_server_transport");
  if (command && url) throw httpError(400, "multiple_mcp_server_transports");

  const lifecycle = cleanText(source.lifecycle, 32).toLowerCase();
  if (!MCP_LIFECYCLES.has(lifecycle)) throw httpError(400, "invalid_mcp_lifecycle");
  rejectLiteralSecretFields(source);

  const config = command ? {
    command,
    args: normalizeStringArray(source.args, "invalid_mcp_args"),
  } : {
    url,
  };

  const env = normalizeStringMap(source.env, "invalid_mcp_env");
  const headers = normalizeStringMap(source.headers, "invalid_mcp_headers");
  const cwd = cleanText(source.cwd, MAX_MCP_ENV_VALUE_LENGTH);
  if (Object.keys(env).length) config.env = env;
  if (Object.keys(headers).length) config.headers = headers;
  if (cwd) config.cwd = cwd;
  if (lifecycle) config.lifecycle = lifecycle;
  if (source.directTools === true || source.directTools === false) config.directTools = source.directTools;

  const auth = normalizeMcpAuth(source, Boolean(url), headers);
  Object.assign(config, auth);

  return {name, config};
}

function normalizeMcpAuth(source, hasUrl, headers) {
  const hasAuthFields = ["authMode", "scopes", "oauthClientRef", "bearerTokenEnv", "secretRefs", "oauthRedirectUri"]
      .some((key) => source[key] != null && source[key] !== "");
  const authMode = cleanText(source.authMode, 32).toLowerCase() || "none";
  if (!MCP_AUTH_MODES.has(authMode)) throw httpError(400, "invalid_mcp_auth_mode");
  const scopes = normalizeScopes(source.scopes);
  const oauthClientRef = cleanReference(source.oauthClientRef, "invalid_mcp_oauth_client_ref");
  const bearerTokenEnv = cleanEnvReference(source.bearerTokenEnv, "invalid_mcp_bearer_token_env");
  const secretRefs = normalizeSecretRefs(source.secretRefs);
  const oauthRedirectUri = cleanText(source.oauthRedirectUri, MAX_MCP_ENV_VALUE_LENGTH);

  if (authMode !== "none" && !hasUrl) throw httpError(400, "invalid_mcp_auth_transport");
  if (authMode === "oauth2" && (!oauthClientRef || !scopes.length)) {
    throw httpError(400, "invalid_mcp_oauth_config");
  }
  if (authMode === "bearer_env" && !bearerTokenEnv) {
    throw httpError(400, "invalid_mcp_bearer_config");
  }
  if (authMode === "none" && (oauthClientRef || scopes.length || bearerTokenEnv || Object.keys(secretRefs).length || oauthRedirectUri)) {
    throw httpError(400, "invalid_mcp_auth_config");
  }
  if (authMode === "oauth2" && Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
    throw httpError(400, "literal_mcp_credential_not_allowed");
  }
  if (authMode === "none" && !hasAuthFields) return {};

  const result = {authMode};
  if (oauthClientRef) result.oauthClientRef = oauthClientRef;
  if (scopes.length) result.scopes = scopes;
  if (bearerTokenEnv) result.bearerTokenEnv = bearerTokenEnv;
  if (Object.keys(secretRefs).length) result.secretRefs = secretRefs;
  if (oauthRedirectUri) result.oauthRedirectUri = oauthRedirectUri;
  return result;
}

function normalizeScopes(value) {
  if (value == null || value === "") return [];
  if (!Array.isArray(value)) throw httpError(400, "invalid_mcp_scopes");
  const scopes = [...new Set(value.map((scope) => cleanText(scope, MAX_MCP_ENV_VALUE_LENGTH)))].filter(Boolean);
  if (scopes.some((scope) => !/^https:\/\/[^\s]+$/.test(scope))) throw httpError(400, "invalid_mcp_scopes");
  return scopes;
}

function normalizeSecretRefs(value) {
  if (value == null || value === "") return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "invalid_mcp_secret_refs");
  const result = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!/^(accessToken|refreshToken|clientSecret|authorizationCode)$/.test(key)) {
      throw httpError(400, "invalid_mcp_secret_refs");
    }
    result[key] = cleanEnvReference(rawValue, "invalid_mcp_secret_refs");
  }
  return result;
}

function cleanReference(value, errorCode) {
  if (value == null || value === "") return "";
  const reference = cleanText(value, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(reference)) throw httpError(400, errorCode);
  return reference;
}

function cleanEnvReference(value, errorCode) {
  if (value == null || value === "") return "";
  const reference = cleanText(value, 128);
  if (!MCP_ENV_REF_PATTERN.test(reference)) throw httpError(400, errorCode);
  return reference;
}

function rejectLiteralSecretFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(accessToken|refreshToken|clientSecret|authorizationCode|clientSecretValue)$/.test(key)) {
      throw httpError(400, "literal_mcp_credential_not_allowed");
    }
    if (key !== "headers" && key !== "env" && key !== "secretRefs") rejectLiteralSecretFields(nested);
  }
}

function cleanMcpName(value) {
  const name = cleanName(value).toLowerCase();
  if (!name || name.length > MAX_MCP_NAME_LENGTH || !MCP_NAME_PATTERN.test(name)) {
    throw httpError(400, "invalid_mcp_server_name");
  }
  return name;
}

function cleanText(value, maxLength) {
  if (value == null) return "";
  const text = String(value).trim();
  if (text.length > maxLength) throw httpError(400, "invalid_mcp_value");
  return text;
}

function normalizeStringArray(value, errorCode) {
  if (value == null || value === "") return [];
  if (!Array.isArray(value)) throw httpError(400, errorCode);
  return value.map((item) => cleanText(item, MAX_MCP_ARG_LENGTH)).filter(Boolean);
}

function normalizeStringMap(value, errorCode) {
  if (value == null || value === "") return {};
  if (typeof value !== "object" || Array.isArray(value)) throw httpError(400, errorCode);
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = cleanName(rawKey);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw httpError(400, errorCode);
    const text = cleanText(rawValue, MAX_MCP_ENV_VALUE_LENGTH);
    if (text) result[key] = text;
  }
  return result;
}

function mcpConfigForRunner(workspace = {}) {
  return normalizeStoredMcpConfig(workspace.mcpConfig || {});
}

function normalizeStoredMcpConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return normalizeMcpConfigPayload({mcpServers: source.mcpServers || {}});
}

module.exports = {
  mcpConfigForRunner,
  normalizeMcpConfigPayload,
  normalizeStoredMcpConfig,
};
