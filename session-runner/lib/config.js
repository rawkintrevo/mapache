"use strict";

const path = require("path");
const {
  envFlag,
  normalizeEnvString,
  normalizePrefix,
  parseSyncPolicyExclude,
  positiveNumber,
} = require("./utils");
const {
  DIRECTORY_MARKER_FILE,
  LEGACY_DIRECTORY_MARKER_FILE,
  INTERNAL_STORAGE_DIR,
  LEGACY_INTERNAL_STORAGE_DIR,
} = require("./runtimePaths");

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
  const homeDir = path.resolve(process.env.MAPACHE_HOME_DIR || process.env.HOME || "/root");
  const piHomeDir = path.join(homeDir, ".pi");
  const piAgentDir = normalizeEnvString(process.env.PI_CODING_AGENT_DIR) || path.join(piHomeDir, "agent");
  const bucketName = process.env.STORAGE_BUCKET || "";
  const prefix = normalizePrefix(process.env.STORAGE_PREFIX || "");
  const homeStorageBucketName = process.env.HOME_STORAGE_BUCKET || bucketName;
  const homeStoragePrefix = normalizePrefix(process.env.HOME_STORAGE_PREFIX || "");
  const homeSyncMode = normalizeEnvString(process.env.HOME_SYNC_MODE) || "persistent";
  const homeArchiveName = normalizeEnvString(process.env.HOME_ARCHIVE_NAME) || "home.tar.gz";
  const piSessionDir = normalizeEnvString(process.env.PI_SESSION_DIR) ||
    path.join(piAgentDir, "mapache-sessions", process.env.SESSION_ID || "session");
  const piSessionStorageBucket = process.env.PI_SESSION_STORAGE_BUCKET || bucketName;
  const piSessionStoragePrefix = normalizePrefix(process.env.PI_SESSION_STORAGE_PREFIX || "");
  const codexHomeDir = path.resolve(process.env.CODEX_HOME || path.join("/tmp", "mapache-codex", process.env.SESSION_ID || "session"));
  const codexHomeStorageBucketName = process.env.CODEX_HOME_STORAGE_BUCKET || bucketName;
  const codexHomeStoragePrefix = normalizePrefix(process.env.CODEX_HOME_STORAGE_PREFIX || "");
  const workspaceSourceMode = normalizeWorkspaceSourceMode(process.env.WORKSPACE_SOURCE_TYPE);
  const workspaceSyncPolicyMode = normalizeEnvString(process.env.WORKSPACE_SYNC_POLICY_MODE) || "blank";
  const workspaceSyncPolicyExclude = parseSyncPolicyExclude(process.env.WORKSPACE_SYNC_POLICY_EXCLUDE);
  const runnerCapabilities = parseRunnerCapabilities();
  const previewEnabled = envFlag(process.env.PREVIEW_ENABLED) && runnerCapabilities.preview;
  const previewBasePath = normalizePreviewBasePath(process.env.PREVIEW_BASE_PATH || "/preview");
  const browserQaDir = path.resolve(process.env.MAPACHE_QA_DIR || path.join(workspaceDir, ".mapache", "qa"));
  const sshConfigDir = path.join(homeDir, ".mapache", "ssh");

  return {
    activityWriteDebounceMs: positiveNumber(process.env.ACTIVITY_WRITE_DEBOUNCE_MS, 15000),
    archiveStorageDir: `${INTERNAL_STORAGE_DIR}/archives`,
    archiveSyncIntervalMs: Number(process.env.ARCHIVE_SYNC_INTERVAL_MS || 300000),
    browserQaActionTimeoutMs: positiveNumber(process.env.BROWSER_QA_ACTION_TIMEOUT_MS, 5000),
    browserQaBaseUrl: normalizeEnvString(process.env.MAPACHE_PREVIEW_URL) || `http://127.0.0.1:${process.env.PORT || 8080}${previewBasePath}/`,
    browserQaCommand: normalizeEnvString(process.env.MAPACHE_BROWSER_QA_COMMAND) || "mapache-preview-qa",
    browserQaDir,
    browserQaExecutablePath: normalizeEnvString(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) || "/usr/bin/chromium",
    browserQaHeadless: envFlag(process.env.BROWSER_QA_HEADLESS, true),
    browserQaNavigationTimeoutMs: positiveNumber(process.env.BROWSER_QA_NAVIGATION_TIMEOUT_MS, 15000),
    browserQaStatePath: path.join(browserQaDir, "last-run.json"),
    bucketName,
    codexHomeDir,
    codexHomeStorageBucketName,
    codexHomeStoragePrefix,
    directoryMarkerFile: DIRECTORY_MARKER_FILE,
    githubCloneToken: normalizeEnvString(process.env.GITHUB_CLONE_TOKEN),
    githubCloneUsername: normalizeEnvString(process.env.GITHUB_CLONE_USERNAME) || "x-access-token",
    githubAutomationToken: normalizeEnvString(process.env.GITHUB_AUTOMATION_TOKEN),
    githubAutomationUsername: normalizeEnvString(process.env.GITHUB_AUTOMATION_USERNAME) || "x-access-token",
    githubRepoUrl: normalizeEnvString(process.env.GITHUB_REPO_URL),
    githubRepoOwner: normalizeEnvString(process.env.GITHUB_REPO_OWNER),
    githubRepoName: normalizeEnvString(process.env.GITHUB_REPO_NAME),
    githubRequestedBranch: normalizeEnvString(process.env.GITHUB_REQUESTED_BRANCH),
    githubRequestedCommit: normalizeEnvString(process.env.GITHUB_REQUESTED_COMMIT),
    homeArchiveName,
    homeDir,
    homeStorageBucketName,
    homeStoragePrefix,
    homeSyncMode,
    internalStorageDir: INTERNAL_STORAGE_DIR,
    legacyArchiveStorageDirs: [`${LEGACY_INTERNAL_STORAGE_DIR}/archives`],
    legacyDirectoryMarkerFiles: [LEGACY_DIRECTORY_MARKER_FILE],
    legacyInternalStorageDirs: [LEGACY_INTERNAL_STORAGE_DIR],
    mcpConfigRaw: process.env.MCP_CONFIG || "",
    ownerUid: process.env.OWNER_UID || "",
    piAgentDir,
    piHomeDir,
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
    sshCertificate: normalizeEnvString(process.env.SSH_CERTIFICATE),
    sshCertificatePath: path.join(sshConfigDir, "id_user-cert.pub"),
    sshConfigDir,
    sshHost: normalizeEnvString(process.env.SSH_TARGET_HOST),
    sshInitialDirectory: normalizeEnvString(process.env.SSH_INITIAL_DIRECTORY) || "~",
    sshKnownHosts: normalizeEnvString(process.env.SSH_KNOWN_HOSTS),
    sshKnownHostsPath: path.join(sshConfigDir, "known_hosts"),
    sshMaxFileBytes: positiveNumber(process.env.SSH_MAX_FILE_BYTES, 1024 * 1024),
    sshPort: positiveNumber(process.env.SSH_TARGET_PORT, 22),
    sshPrivateKey: normalizeEnvString(process.env.SSH_PRIVATE_KEY),
    sshPrivateKeyPath: path.join(sshConfigDir, "id_user"),
    sshShell: normalizeEnvString(process.env.SSH_SHELL) || "bash",
    sshStrictHostKeyChecking: envFlag(process.env.SSH_STRICT_HOST_KEY_CHECKING, true),
    sshUsername: normalizeEnvString(process.env.SSH_TARGET_USERNAME),
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
