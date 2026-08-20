"use strict";

const {httpError} = require("./backendUtils.helpers");

const GOOGLE_SERVICE_KEYS = Object.freeze([
  "gmail",
  "drive",
  "docs",
  "sheets",
  "slides",
  "calendar",
  "chat",
  "people",
]);
const GOOGLE_SERVICE_KEY_SET = new Set(GOOGLE_SERVICE_KEYS);
const CONNECTION_STATUSES = new Set(["connected", "reconnect_required", "revoked", "disconnected"]);
const SECRET_FIELD_PATTERN = /(?:access|refresh|client|authorization|bearer|token|secret|code)/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCOPE_PATTERN = /^https:\/\/[^\s]+$/;
const OIDC_SCOPE_NAMES = new Set(["openid", "email", "profile"]);
const SAFE_FIELD_NAMES = new Set([
  "connectionId", "id", "googleSubject", "subject", "email", "displayName",
  "grantedScopes", "scopes", "enabledServices", "serviceKeys", "oauthClientRef",
  "status", "createdAt", "updatedAt", "lastRefreshedAt",
]);

function normalizeGoogleConnectionMetadata(input = {}) {
  assertPlainObject(input, "invalid_google_connection");
  rejectSecretFields(input);

  const connectionId = requiredId(input.connectionId || input.id, "invalid_google_connection_id");
  const googleSubject = requiredText(input.googleSubject || input.subject, "invalid_google_subject", 256);
  const email = requiredEmail(input.email);
  const displayName = optionalText(input.displayName, 256);
  const grantedScopes = normalizeScopes(input.grantedScopes || input.scopes);
  const enabledServices = normalizeServiceKeys(input.enabledServices || input.serviceKeys);
  const oauthClientRef = requiredId(input.oauthClientRef, "invalid_google_oauth_client_ref");
  const status = String(input.status || "connected").trim().toLowerCase();
  if (!CONNECTION_STATUSES.has(status)) throw httpError(400, "invalid_google_connection_status");

  return {
    connectionId,
    googleSubject,
    email,
    displayName,
    grantedScopes,
    enabledServices,
    oauthClientRef,
    status,
    createdAt: normalizeTimestamp(input.createdAt),
    updatedAt: normalizeTimestamp(input.updatedAt),
    lastRefreshedAt: normalizeTimestamp(input.lastRefreshedAt),
  };
}

function normalizeGoogleWorkspaceBinding(input = {}) {
  assertPlainObject(input, "invalid_google_workspace_binding");
  rejectSecretFields(input);
  const connectionId = requiredId(input.connectionId, "invalid_google_connection_id");
  const enabledServices = normalizeServiceKeys(input.enabledServices || input.serviceKeys);
  if (!enabledServices.length) throw httpError(400, "google_services_required");
  return {connectionId, enabledServices};
}

function normalizeGoogleConnectionSummary(input = {}) {
  const metadata = normalizeGoogleConnectionMetadata(input);
  return {
    connectionId: metadata.connectionId,
    email: metadata.email,
    displayName: metadata.displayName,
    enabledServices: metadata.enabledServices,
    status: metadata.status,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    lastRefreshedAt: metadata.lastRefreshedAt,
  };
}

function normalizeServiceKeys(value) {
  if (!Array.isArray(value)) throw httpError(400, "invalid_google_service_keys");
  const keys = [...new Set(value.map((item) => String(item || "").trim().toLowerCase()))];
  if (keys.some((key) => !GOOGLE_SERVICE_KEY_SET.has(key))) {
    throw httpError(400, "invalid_google_service_keys");
  }
  return keys;
}

function normalizeScopes(value) {
  if (!Array.isArray(value)) throw httpError(400, "invalid_google_scopes");
  const scopes = [...new Set(value.map((scope) => String(scope || "").trim()))];
  if (scopes.some((scope) => !SCOPE_PATTERN.test(scope) && !OIDC_SCOPE_NAMES.has(scope))) {
    throw httpError(400, "invalid_google_scopes");
  }
  return scopes;
}

function normalizeTimestamp(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "object" && typeof value.toDate === "function") {
    return normalizeTimestamp(value.toDate());
  }
  throw httpError(400, "invalid_google_timestamp");
}

function requiredId(value, errorCode) {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id)) throw httpError(400, errorCode);
  return id;
}

function requiredText(value, errorCode, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) throw httpError(400, errorCode);
  return text;
}

function optionalText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length > maxLength) throw httpError(400, "invalid_google_display_name");
  return text;
}

function requiredEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) throw httpError(400, "invalid_google_email");
  return email;
}

function assertPlainObject(value, errorCode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, errorCode);
}

function rejectSecretFields(value) {
  for (const [key, nested] of Object.entries(value)) {
    if (!SAFE_FIELD_NAMES.has(key) && SECRET_FIELD_PATTERN.test(key)) {
      throw httpError(400, "google_credential_material_not_allowed");
    }
    if (nested && typeof nested === "object") rejectSecretFields(nested);
  }
}

module.exports = {
  CONNECTION_STATUSES,
  GOOGLE_SERVICE_KEYS,
  normalizeGoogleConnectionMetadata,
  normalizeGoogleConnectionSummary,
  normalizeGoogleWorkspaceBinding,
};
