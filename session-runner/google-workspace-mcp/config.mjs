const GOOGLE_AUTH_SCOPE_PREFIX = "https://www.googleapis.com/auth/";

export const GOOGLE_WORKSPACE_SERVICES = Object.freeze([
  "calendar",
  "gmail",
  "drive",
  "docs",
  "sheets",
  "slides",
]);

export const GOOGLE_WORKSPACE_SCOPE_CATALOG = Object.freeze({
  calendar: Object.freeze({
    read: Object.freeze([
      `${GOOGLE_AUTH_SCOPE_PREFIX}calendar.calendarlist.readonly`,
      `${GOOGLE_AUTH_SCOPE_PREFIX}calendar.events.freebusy`,
      `${GOOGLE_AUTH_SCOPE_PREFIX}calendar.events.readonly`,
    ]),
    write: Object.freeze([`${GOOGLE_AUTH_SCOPE_PREFIX}calendar.events`]),
  }),
  gmail: Object.freeze({
    read: Object.freeze([`${GOOGLE_AUTH_SCOPE_PREFIX}gmail.readonly`]),
    write: Object.freeze([
      `${GOOGLE_AUTH_SCOPE_PREFIX}gmail.compose`,
      `${GOOGLE_AUTH_SCOPE_PREFIX}gmail.modify`,
    ]),
  }),
  drive: Object.freeze({
    read: Object.freeze([`${GOOGLE_AUTH_SCOPE_PREFIX}drive.readonly`]),
    write: Object.freeze([`${GOOGLE_AUTH_SCOPE_PREFIX}drive.file`]),
  }),
  docs: Object.freeze({
    read: Object.freeze([
      `${GOOGLE_AUTH_SCOPE_PREFIX}drive.readonly`,
      `${GOOGLE_AUTH_SCOPE_PREFIX}documents.readonly`,
    ]),
    write: Object.freeze([
      `${GOOGLE_AUTH_SCOPE_PREFIX}drive.file`,
      `${GOOGLE_AUTH_SCOPE_PREFIX}documents`,
    ]),
  }),
  sheets: Object.freeze({
    read: Object.freeze([
      `${GOOGLE_AUTH_SCOPE_PREFIX}drive.readonly`,
      `${GOOGLE_AUTH_SCOPE_PREFIX}spreadsheets.readonly`,
    ]),
    write: Object.freeze([
      `${GOOGLE_AUTH_SCOPE_PREFIX}drive.file`,
      `${GOOGLE_AUTH_SCOPE_PREFIX}spreadsheets`,
    ]),
  }),
  slides: Object.freeze({
    read: Object.freeze([
      `${GOOGLE_AUTH_SCOPE_PREFIX}drive.readonly`,
      `${GOOGLE_AUTH_SCOPE_PREFIX}presentations.readonly`,
    ]),
    write: Object.freeze([
      `${GOOGLE_AUTH_SCOPE_PREFIX}drive.file`,
      `${GOOGLE_AUTH_SCOPE_PREFIX}presentations`,
    ]),
  }),
});

const SERVICE_SET = new Set(GOOGLE_WORKSPACE_SERVICES);
const SAFE_SCOPE_PATTERN = /^https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._:-]+$/;
const IDENTITY_SCOPES = new Set(["openid", "email", "profile"]);

export class GoogleWorkspaceConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GoogleWorkspaceConfigError";
    this.code = code;
  }
}

export function createGoogleWorkspaceConfig({env = process.env} = {}) {
  const enabledServices = parseEnabledServices(env?.GOOGLE_MCP_ENABLED_SERVICES);
  const grantedScopes = parseGrantedScopes(env?.GOOGLE_MCP_GRANTED_SCOPES);
  const config = Object.freeze({
    enabledServices,
    grantedScopes,
  });
  return Object.freeze({
    ...config,
    isServiceEnabled: (serviceKey) => isServiceEnabled(config, serviceKey),
    hasReadScope: (serviceKey) => hasReadScope(config, serviceKey),
    hasWriteScope: (serviceKey) => hasWriteScope(config, serviceKey),
  });
}

export function parseEnabledServices(value) {
  const values = parseListValue(value, "google_enabled_services_invalid");
  const services = dedupe(values.map((item) => String(item).trim().toLowerCase()));
  if (services.some((service) => !SERVICE_SET.has(service))) {
    throw new GoogleWorkspaceConfigError("google_service_unsupported", "Google Workspace service is unsupported.");
  }
  return services.filter((service) => SERVICE_SET.has(service));
}

export function parseGrantedScopes(value) {
  const scopes = dedupe(parseListValue(value, "google_granted_scopes_invalid").map((item) => String(item).trim()));
  if (scopes.some((scope) => !IDENTITY_SCOPES.has(scope) && !SAFE_SCOPE_PATTERN.test(scope))) {
    throw new GoogleWorkspaceConfigError("google_granted_scope_invalid", "Google Workspace scope is invalid.");
  }
  return scopes;
}

export function isServiceEnabled(config, serviceKey) {
  const key = String(serviceKey || "").trim().toLowerCase();
  return SERVICE_SET.has(key) && config?.enabledServices?.includes(key) === true;
}

export function hasReadScope(config, serviceKey) {
  const key = String(serviceKey || "").trim().toLowerCase();
  const required = GOOGLE_WORKSPACE_SCOPE_CATALOG[key]?.read || [];
  return isServiceEnabled(config, key) && required.every((scope) => config.grantedScopes?.includes(scope));
}

export function hasWriteScope(config, serviceKey) {
  const key = String(serviceKey || "").trim().toLowerCase();
  const required = GOOGLE_WORKSPACE_SCOPE_CATALOG[key]?.write || [];
  return hasReadScope(config, key) && required.every((scope) => config.grantedScopes?.includes(scope));
}

export function hasGrantedScope(config, serviceKey, scope) {
  return isServiceEnabled(config, serviceKey) && config.grantedScopes?.includes(scope) === true;
}

function parseListValue(value, errorCode) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch (error) {
    if (raw.startsWith("[") || raw.startsWith("{")) {
      throw new GoogleWorkspaceConfigError(errorCode, "Google Workspace configuration must be a list.");
    }
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}
