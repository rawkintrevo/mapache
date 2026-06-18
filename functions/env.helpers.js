"use strict";

const {httpError} = require("./backendUtils.helpers");

const MAX_ENV_VARS = 100;
const MAX_ENV_VALUE_BYTES = 8192;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RESERVED_ENV_NAMES = new Set([
  "FIREBASE_PROJECT_ID",
  "GITHUB_AUTOMATION_TOKEN",
  "GITHUB_AUTOMATION_USERNAME",
  "GITHUB_CHECKOUT_REF",
  "GITHUB_CLONE_TOKEN",
  "GITHUB_CLONE_USERNAME",
  "GITHUB_REPO_NAME",
  "GITHUB_REPO_OWNER",
  "GITHUB_REPO_URL",
  "GITHUB_REQUESTED_BRANCH",
  "GITHUB_REQUESTED_COMMIT",
  "GITHUB_RESOLVED_BRANCH",
  "GITHUB_RESOLVED_COMMIT",
  "HOME",
  "HOME_STORAGE_BUCKET",
  "HOME_STORAGE_PREFIX",
  "HOME_SYNC_MODE",
  "MAPACHE_HOME_DIR",
  "MAPACHE_PREVIEW_URL",
  "MAPACHE_QA_DIR",
  "MAPACHE_RUNNER_URL",
  "OWNER_UID",
  "PI_CODING_AGENT_DIR",
  "PORT",
  "PREVIEW_BASE_PATH",
  "PREVIEW_ENABLED",
  "PREVIEW_INJECT_LOGGER",
  "PREVIEW_LOG_LIMIT",
  "PREVIEW_N64_ROM_PATH",
  "PREVIEW_STATIC_ROOT",
  "RESTART_NONCE",
  "RUNNER_CAPABILITIES",
  "SESSION_BROWSER_TOKEN_SECRET",
  "SESSION_ID",
  "SESSION_NAME",
  "SESSION_SHUTDOWN_TOKEN",
  "STORAGE_BUCKET",
  "STORAGE_PREFIX",
  "SYNC_INTERVAL_MS",
  "TERMINAL_ARGS",
  "TERMINAL_COMMAND",
  "TERMINAL_KIND",
  "WORKSPACE_DIR",
  "WORKSPACE_ID",
  "WORKSPACE_SOURCE_TYPE",
  "WORKSPACE_SYNC_POLICY_EXCLUDE",
  "WORKSPACE_SYNC_POLICY_MODE",
]);

function normalizeEnvMap(value, options = {}) {
  if (value == null || value === "") return {};
  if (Array.isArray(value) || typeof value !== "object") {
    throw httpError(400, options.errorCode || "invalid_env");
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_ENV_VARS) {
    throw httpError(400, options.tooManyErrorCode || "too_many_env_vars");
  }

  return entries.reduce((acc, [rawName, rawValue]) => {
    const name = String(rawName || "").trim();
    if (!ENV_NAME_PATTERN.test(name)) {
      throw httpError(400, options.invalidNameErrorCode || "invalid_env_name");
    }
    if (RESERVED_ENV_NAMES.has(name)) {
      throw httpError(400, options.reservedNameErrorCode || "reserved_env_name");
    }
    const itemValue = rawValue == null ? "" : String(rawValue);
    if (Buffer.byteLength(itemValue, "utf8") > MAX_ENV_VALUE_BYTES) {
      throw httpError(400, options.valueTooLargeErrorCode || "env_value_too_large");
    }
    acc[name] = itemValue;
    return acc;
  }, {});
}

function envMapToCloudRunEnv(value) {
  return Object.entries(normalizeEnvMap(value)).map(([name, item]) => ({
    name,
    value: item,
  }));
}

module.exports = {
  ENV_NAME_PATTERN,
  RESERVED_ENV_NAMES,
  envMapToCloudRunEnv,
  normalizeEnvMap,
};
