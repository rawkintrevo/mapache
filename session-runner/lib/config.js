"use strict";

const path = require("path");
const {
  envFlag,
  normalizeEnvString,
  normalizePrefix,
  parseSyncPolicyExclude,
  positiveNumber,
} = require("./utils");

function normalizeWorkspaceSourceMode(value) {
  return String(value || "blank").trim().toLowerCase() === "github" ? "github" : "blank";
}

function normalizePreviewBasePath(value) {
  const clean = `/${String(value || "/preview").replace(/^\/+|\/+$/g, "")}`;
  return clean === "/" ? "/preview" : clean;
}

function parseRunnerCapabilities() {
  const fallback = {terminal: true, preview: false, previewQa: false, functions: false, n64: false};
  try {
    return {...fallback, ...JSON.parse(process.env.RUNNER_CAPABILITIES || "{}")};
  } catch (error) {
    console.error("invalid RUNNER_CAPABILITIES, using fallback", error);
    return fallback;
  }
}

function createConfig() {
  const workspaceDir = process.env.WORKSPACE_DIR || "/workspace";
  const bucketName = process.env.STORAGE_BUCKET || "";
  const prefix = normalizePrefix(process.env.STORAGE_PREFIX || "");
  const piHomeBucketName = process.env.PI_HOME_STORAGE_BUCKET || bucketName;
  const piHomePrefix = normalizePrefix(process.env.PI_HOME_STORAGE_PREFIX || "");
  const piSessionDir = normalizeEnvString(process.env.PI_SESSION_DIR) ||
    path.join(process.env.PI_HOME_DIR || "/root/.pi", "agent", "mapache-sessions", process.env.SESSION_ID || "session");
  const piSessionStorageBucket = process.env.PI_SESSION_STORAGE_BUCKET || bucketName;
  const piSessionStoragePrefix = normalizePrefix(process.env.PI_SESSION_STORAGE_PREFIX || "");
  const workspaceSourceMode = normalizeWorkspaceSourceMode(process.env.WORKSPACE_SOURCE_TYPE);
  const workspaceSyncPolicyMode = normalizeEnvString(process.env.WORKSPACE_SYNC_POLICY_MODE) || "blank";
  const workspaceSyncPolicyExclude = parseSyncPolicyExclude(process.env.WORKSPACE_SYNC_POLICY_EXCLUDE);
  const runnerCapabilities = parseRunnerCapabilities();
  const previewEnabled = envFlag(process.env.PREVIEW_ENABLED) && runnerCapabilities.preview;
  const previewBasePath = normalizePreviewBasePath(process.env.PREVIEW_BASE_PATH || "/preview");

  return {
    activityWriteDebounceMs: positiveNumber(process.env.ACTIVITY_WRITE_DEBOUNCE_MS, 15000),
    archiveStorageDir: ".mapahce-internal/archives",
    archiveSyncIntervalMs: Number(process.env.ARCHIVE_SYNC_INTERVAL_MS || 300000),
    bucketName,
    directoryMarkerFile: ".mapahce-directory",
    githubCloneToken: normalizeEnvString(process.env.GITHUB_CLONE_TOKEN),
    githubCloneUsername: normalizeEnvString(process.env.GITHUB_CLONE_USERNAME) || "x-access-token",
    githubAutomationToken: normalizeEnvString(process.env.GITHUB_AUTOMATION_TOKEN),
    githubAutomationUsername: normalizeEnvString(process.env.GITHUB_AUTOMATION_USERNAME) || "x-access-token",
    githubRepoUrl: normalizeEnvString(process.env.GITHUB_REPO_URL),
    githubRepoOwner: normalizeEnvString(process.env.GITHUB_REPO_OWNER),
    githubRepoName: normalizeEnvString(process.env.GITHUB_REPO_NAME),
    githubRequestedBranch: normalizeEnvString(process.env.GITHUB_REQUESTED_BRANCH),
    githubRequestedCommit: normalizeEnvString(process.env.GITHUB_REQUESTED_COMMIT),
    internalStorageDir: ".mapahce-internal",
    ownerUid: process.env.OWNER_UID || "",
    piHomeBucketName,
    piHomePrefix,
    piSessionDir,
    piSessionJsonlPath: normalizeEnvString(process.env.PI_SESSION_JSONL_PATH),
    piSessionStorageBucket,
    piSessionStoragePrefix,
    port: Number(process.env.PORT || 8080),
    prefix,
    previewBasePath,
    previewConfigPath: path.join(workspaceDir, ".mapache", "preview.json"),
    previewEnabled,
    previewInjectLogger: previewEnabled && envFlag(process.env.PREVIEW_INJECT_LOGGER, true),
    previewLogLimit: positiveNumber(process.env.PREVIEW_LOG_LIMIT, 500),
    previewN64RomPath: path.resolve(process.env.PREVIEW_N64_ROM_PATH || path.join(workspaceDir, "build", "game.z64")),
    previewStaticRoot: path.resolve(process.env.PREVIEW_STATIC_ROOT || path.join(workspaceDir, "build")),
    runnerCapabilities,
    sessionBrowserTokenSecret: normalizeEnvString(process.env.SESSION_BROWSER_TOKEN_SECRET),
    sessionId: process.env.SESSION_ID || "",
    sessionName: normalizeEnvString(process.env.SESSION_NAME) || "Terminal session",
    shutdownToken: process.env.SESSION_SHUTDOWN_TOKEN || "",
    syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 30000),
    terminalReplayLimit: positiveNumber(process.env.TERMINAL_REPLAY_LIMIT, 1000000),
    terminalKind: normalizeEnvString(process.env.TERMINAL_KIND) || "pi",
    workspaceDir,
    workspaceId: process.env.WORKSPACE_ID || "",
    workspaceSourceMode,
    workspaceSyncPolicyExclude,
    workspaceSyncPolicyMode,
  };
}

module.exports = {
  createConfig,
  normalizePreviewBasePath,
  normalizeWorkspaceSourceMode,
  parseRunnerCapabilities,
};
