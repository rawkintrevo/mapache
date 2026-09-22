"use strict";

const path = require("path");
const {boundedUnixSocketPath} = require("./unixSocketPath.helpers");
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
  SHARED_WORKSPACE_READY_MARKER,
} = require("./runtimePaths");
const {isAutomationRuntime, normalizeRuntimeKind} = require("./runtimePaths");
const {
  DEFAULT_PRIVATE_RUNTIME_ROOT,
  isPrivateRuntimeStorageMode,
  normalizeRuntimeIdentity,
  normalizeRuntimeStorageMode,
  privateRuntimePaths,
} = require("./runtimeStorage.helpers");
const {SHARED_WORKSPACE_STORAGE_MODE} = require("./sharedWorkspace.helpers");

function normalizeWorkspaceSourceMode(value) {
  return String(value || "blank").trim().toLowerCase() === "github" ? "github" : "blank";
}

function normalizeWorkspaceSyncRole(value) {
  const role = normalizeEnvString(value).toLowerCase();
  return role === "reader" || role === "none" ? role : "writer";
}

function normalizePreviewBasePath(value) {
  const clean = `/${String(value || "/preview").replace(/^\/+|\/+$/g, "")}`;
  return clean === "/" ? "/preview" : clean;
}

const {AUTOMATION_STORAGE_MODE, isAutomationStorageMode} = require("./automationStorage.helpers");

const PI_MCP_ADAPTER_VERSION = "2.32.1";

function parseRunnerCapabilities() {
  const fallback = {terminal: true, preview: true, previewQa: true, functions: true, chrome: true};
  try {
    const parsed = JSON.parse(process.env.RUNNER_CAPABILITIES || "{}");
    return Object.fromEntries(Object.keys(fallback).map((key) => [
      key,
      Boolean(parsed && Object.prototype.hasOwnProperty.call(parsed, key) ? parsed[key] : fallback[key]),
    ]));
  } catch (error) {
    console.error("invalid RUNNER_CAPABILITIES, using fallback", error);
    return fallback;
  }
}

function createConfig({workspaceGoogleApplicationCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS} = {}) {
  const workspaceDir = process.env.WORKSPACE_DIR || "/workspace";
  const runtimeKind = normalizeRuntimeKind(process.env.MAPACHE_RUNTIME_KIND || process.env.RUNTIME_KIND);
  const requestedWorkspaceMode = normalizeEnvString(process.env.WORKSPACE_STORAGE_MODE).toLowerCase();
  const workspaceStorageMode = [SHARED_WORKSPACE_STORAGE_MODE, AUTOMATION_STORAGE_MODE].includes(requestedWorkspaceMode) ? requestedWorkspaceMode : "legacy";
  const automationRunId = isAutomationRuntime(runtimeKind) ?
    String(process.env.MAPACHE_AUTOMATION_RUN_ID || process.env.AUTOMATION_RUN_ID || "").trim() : "";
  const requestedRuntimeStorageMode = normalizeRuntimeStorageMode(
    process.env.MAPACHE_RUNTIME_STORAGE_MODE || process.env.RUNTIME_STORAGE_MODE,
  );
  const runtimeStorageMode = [SHARED_WORKSPACE_STORAGE_MODE, AUTOMATION_STORAGE_MODE].includes(workspaceStorageMode) ? "private" : requestedRuntimeStorageMode;
  const runtimeIdentity = normalizeRuntimeIdentity(
      process.env.MAPACHE_RUNTIME_ID || process.env.RUN_ID || process.env.SESSION_ID,
  );
  const privatePaths = isPrivateRuntimeStorageMode(runtimeStorageMode) ? privateRuntimePaths({
    identity: runtimeIdentity,
    root: process.env.MAPACHE_RUNTIME_ROOT || DEFAULT_PRIVATE_RUNTIME_ROOT,
    runtimeRoot: process.env.MAPACHE_RUNTIME_ROOT && process.env.MAPACHE_RUNTIME_ID ? process.env.MAPACHE_RUNTIME_ROOT : "",
  }) : null;
  const legacyHomeDir = path.resolve(process.env.MAPACHE_HOME_DIR || process.env.HOME || "/root");
  const homeDir = privatePaths?.homeDir || legacyHomeDir;
  const piHomeDir = path.join(homeDir, ".pi");
  const agentUiVersion = normalizeEnvString(process.env.MAPACHE_AGENT_UI_VERSION);
  const agentRuntimeEnabled = agentUiVersion === "pi-web-ui-v1";
  const agentStateRoot = path.resolve(privatePaths?.agentStateRoot || process.env.MAPACHE_AGENT_STATE_ROOT || "/var/lib/mapache/agent");
  const piWebUiRoot = path.resolve(process.env.MAPACHE_PI_WEB_UI_ROOT || "/opt/mapache/pi-web-ui");
  const piWebUiDataDir = path.resolve(privatePaths?.piWebUiDataDir || process.env.MAPACHE_PI_WEB_UI_DATA_DIR || path.join(agentStateRoot, "ui"));
  const piWebUiPiDir = path.resolve(privatePaths?.piAgentDir || process.env.MAPACHE_PI_WEB_UI_PI_DIR || path.join(agentStateRoot, "pi"));
  const piWebUiSessionDir = path.resolve(privatePaths?.piSessionDir || process.env.MAPACHE_PI_WEB_UI_SESSION_DIR || path.join(agentStateRoot, "sessions"));
  const adapterHomeDir = isPrivateRuntimeStorageMode(runtimeStorageMode) ?
    path.resolve(process.env.MAPACHE_IMAGE_HOME_DIR || "/root") : legacyHomeDir;
  const piMcpAdapterPath = normalizeEnvString(process.env.PI_WEB_MCP_ADAPTER_PATH) ||
    path.join(adapterHomeDir, ".pi", "agent", "npm", "node_modules", "pi-mcp-adapter", "index.ts");
  const piAgentDir = privatePaths?.piAgentDir || (agentRuntimeEnabled ? piWebUiPiDir :
    normalizeEnvString(process.env.PI_CODING_AGENT_DIR) || path.join(piHomeDir, "agent"));
  const bucketName = process.env.STORAGE_BUCKET || "";
  const prefix = normalizePrefix(process.env.STORAGE_PREFIX || "");
  const homeStorageBucketName = process.env.HOME_STORAGE_BUCKET || bucketName;
  const homeStoragePrefix = normalizePrefix(process.env.HOME_STORAGE_PREFIX || "");
  const homeSyncMode = isPrivateRuntimeStorageMode(runtimeStorageMode) ? "ephemeral" :
    normalizeEnvString(process.env.HOME_SYNC_MODE) || "persistent";
  const homeArchiveName = normalizeEnvString(process.env.HOME_ARCHIVE_NAME) || "home.tar.gz";
  const piSessionDir = privatePaths?.piSessionDir || (agentRuntimeEnabled ? piWebUiSessionDir :
    normalizeEnvString(process.env.PI_SESSION_DIR) || path.join(piAgentDir, "mapache-sessions", process.env.SESSION_ID || "session"));
  const piSessionStorageBucket = isPrivateRuntimeStorageMode(runtimeStorageMode) ? "" :
    process.env.PI_SESSION_STORAGE_BUCKET || bucketName;
  const piSessionStoragePrefix = isPrivateRuntimeStorageMode(runtimeStorageMode) ? "" :
    normalizePrefix(process.env.PI_SESSION_STORAGE_PREFIX || "");
  const harnessId = "pi";
  const workspaceSourceMode = normalizeWorkspaceSourceMode(process.env.WORKSPACE_SOURCE_TYPE);
  const workspaceSyncRole = normalizeWorkspaceSyncRole(process.env.WORKSPACE_SYNC_ROLE);
  const workspaceSyncPolicyMode = normalizeEnvString(process.env.WORKSPACE_SYNC_POLICY_MODE) || "blank";
  const workspaceSyncPolicyExclude = parseSyncPolicyExclude(process.env.WORKSPACE_SYNC_POLICY_EXCLUDE);
  const qaFaultHarness = normalizeEnvString(process.env.MAPACHE_QA_FAULT_HARNESS);
  const qaCase = normalizeEnvString(process.env.QA_CASE);
  const runnerCapabilities = parseRunnerCapabilities();
  const chromeEnabled = Boolean(runnerCapabilities.chrome);
  const previewEnabled = envFlag(process.env.PREVIEW_ENABLED) && runnerCapabilities.preview;
  const previewBasePath = normalizePreviewBasePath(process.env.PREVIEW_BASE_PATH || "/preview");
  const browserQaDir = path.resolve(privatePaths?.browserQaDir || process.env.MAPACHE_QA_DIR || path.join(workspaceDir, ".mapache", "qa"));
  const piMcpConfigPath = privatePaths?.piMcpConfigPath || path.join(workspaceDir, ".mcp.json");
  const piWebUiControlPath = privatePaths?.piWebUiControlPath || normalizeEnvString(process.env.PI_WEB_UI_CONTROL_PATH);
  const privateGitDir = workspaceStorageMode === SHARED_WORKSPACE_STORAGE_MODE && !isAutomationRuntime(runtimeKind) ?
    path.resolve(normalizeEnvString(process.env.MAPACHE_PRIVATE_GIT_DIR) || "/var/lib/mapache/git/repository") :
    privatePaths?.privateGitDir || "";
  const automationAgentSocketPath = runtimeKind === "automation" ?
    boundedUnixSocketPath(normalizeEnvString(process.env.MAPACHE_AUTOMATION_AGENT_SOCKET) ||
      path.join(privatePaths?.runtimeRoot || "/tmp", "automation-agent.sock")) : "";
  const googleMcpTokenSocketPath = boundedUnixSocketPath(path.join(
      privatePaths?.runtimeRoot || "/tmp",
      `google-mcp-token-${normalizeRuntimeIdentity(runtimeIdentity)}.sock`,
  ));

  return {
    activityWriteDebounceMs: positiveNumber(process.env.ACTIVITY_WRITE_DEBOUNCE_MS, 15000),
    agentAccessAudience: "agent",
    agentRuntimeEnabled,
    agentRuntimeGeneration: normalizeEnvString(process.env.MAPACHE_AGENT_RUNTIME_GENERATION),
    automationAgentApiUrl: normalizeEnvString(process.env.MAPACHE_AUTOMATION_AGENT_API_URL),
    automationAgentSocketPath,
    automationAgentTokenUrl: normalizeEnvString(process.env.MAPACHE_AUTOMATION_AGENT_TOKEN_URL),
    automationRunId,
    automationOutputDir: isAutomationStorageMode(workspaceStorageMode) ? normalizeEnvString(process.env.MAPACHE_AUTOMATION_OUTPUT_DIR) : "",
    workspaceAuthorityRenewalIntervalMs: positiveNumber(process.env.MAPACHE_WORKSPACE_AUTHORITY_RENEWAL_INTERVAL_MS, 5000),
    agentStateRoot,
    agentUiVersion,
    archiveStorageDir: `${INTERNAL_STORAGE_DIR}/archives`,
    archiveSyncIntervalMs: Number(process.env.ARCHIVE_SYNC_INTERVAL_MS || 300000),
    resourceMetricsIntervalMs: positiveNumber(process.env.RESOURCE_METRICS_INTERVAL_MS, 2000),
    browserQaActionTimeoutMs: positiveNumber(process.env.BROWSER_QA_ACTION_TIMEOUT_MS, 5000),
    browserQaBaseUrl: normalizeEnvString(process.env.MAPACHE_PREVIEW_URL) || `http://127.0.0.1:${process.env.PORT || 8080}${previewBasePath}/`,
    browserQaCommand: normalizeEnvString(process.env.MAPACHE_BROWSER_QA_COMMAND) || "mapache-preview-qa",
    browserQaDir,
    browserQaExecutablePath: normalizeEnvString(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) || "/usr/bin/chromium",
    browserQaHeadless: envFlag(process.env.BROWSER_QA_HEADLESS, true),
    browserQaNavigationTimeoutMs: positiveNumber(process.env.BROWSER_QA_NAVIGATION_TIMEOUT_MS, 15000),
    browserQaStatePath: path.join(browserQaDir, "last-run.json"),
    browserActivityUrl: chromeEnabled ?
      normalizeEnvString(process.env.MAPACHE_BROWSER_ACTIVITY_URL) || `http://127.0.0.1:${process.env.PORT || 8080}/browser/activity` : "",
    browserCdpUrl: chromeEnabled ?
      normalizeEnvString(process.env.MAPACHE_BROWSER_CDP_URL) || `http://127.0.0.1:${positiveNumber(process.env.CHROME_CDP_PORT, 9222)}` : "",
    browserStatusUrl: chromeEnabled ?
      normalizeEnvString(process.env.MAPACHE_BROWSER_STATUS_URL) || `http://127.0.0.1:${process.env.PORT || 8080}/browser/status` : "",
    browserStatusCommand: chromeEnabled ? normalizeEnvString(process.env.MAPACHE_BROWSER_STATUS_COMMAND) || "mapache-chrome-status" : "",
    chromeCdpHost: chromeEnabled ? normalizeEnvString(process.env.CHROME_CDP_HOST) || "127.0.0.1" : "",
    chromeCdpPort: chromeEnabled ? positiveNumber(process.env.CHROME_CDP_PORT, 9222) : 0,
    chromeDisplay: chromeEnabled ? normalizeEnvString(process.env.CHROME_DISPLAY) || ":99" : "",
    chromeEnabled,
    chromeDesktopRestartBackoffMs: chromeEnabled ? positiveNumber(process.env.CHROME_DESKTOP_RESTART_BACKOFF_MS, 250) : 0,
    chromeDesktopRestartMaxAttempts: chromeEnabled ? positiveNumber(process.env.CHROME_DESKTOP_RESTART_MAX_ATTEMPTS, 3) : 0,
    chromeNoVncPort: chromeEnabled ? positiveNumber(process.env.CHROME_NOVNC_PORT, 6080) : 0,
    chromeProfileDir: chromeEnabled ? path.resolve(privatePaths?.chromeProfileDir || process.env.CHROME_PROFILE_DIR || "/var/lib/mapache/chrome/profile") : "",
    chromeStartupTimeoutMs: chromeEnabled ? positiveNumber(process.env.CHROME_STARTUP_TIMEOUT_MS, 30000) : 0,
    chromeViewport: chromeEnabled ? {
      width: positiveNumber(process.env.CHROME_VIEWPORT_WIDTH, 1440),
      height: positiveNumber(process.env.CHROME_VIEWPORT_HEIGHT, 1000),
    } : null,
    chromeVncHost: chromeEnabled ? normalizeEnvString(process.env.CHROME_VNC_HOST) || "127.0.0.1" : "",
    chromeVncPort: chromeEnabled ? positiveNumber(process.env.CHROME_VNC_PORT, 5900) : 0,
    bucketName,
    directoryMarkerFile: DIRECTORY_MARKER_FILE,
    githubCloneToken: normalizeEnvString(process.env.GITHUB_CLONE_TOKEN),
    githubCloneUsername: normalizeEnvString(process.env.GITHUB_CLONE_USERNAME) || "x-access-token",
    githubAutomationToken: normalizeEnvString(process.env.GITHUB_AUTOMATION_TOKEN),
    githubAutomationTokenExpiresAt: normalizeEnvString(process.env.GITHUB_AUTOMATION_TOKEN_EXPIRES_AT),
    githubAutomationTokenRefreshUrl: normalizeEnvString(process.env.GITHUB_AUTOMATION_TOKEN_REFRESH_URL),
    githubAutomationUsername: normalizeEnvString(process.env.GITHUB_AUTOMATION_USERNAME) || "x-access-token",
    githubRepoUrl: normalizeEnvString(process.env.GITHUB_REPO_URL),
    githubRepoOwner: normalizeEnvString(process.env.GITHUB_REPO_OWNER),
    githubRepoName: normalizeEnvString(process.env.GITHUB_REPO_NAME),
    githubRequestedBranch: normalizeEnvString(process.env.GITHUB_REQUESTED_BRANCH),
    githubRequestedCommit: normalizeEnvString(process.env.GITHUB_REQUESTED_COMMIT),
    googleMcpAccountEmail: normalizeEnvString(process.env.GOOGLE_MCP_ACCOUNT_EMAIL),
    googleMcpAccountName: normalizeEnvString(process.env.GOOGLE_MCP_ACCOUNT_NAME),
    googleMcpConnectionStatus: normalizeEnvString(process.env.GOOGLE_MCP_CONNECTION_STATUS),
    googleMcpEnabledServices: normalizeEnvString(process.env.GOOGLE_MCP_ENABLED_SERVICES),
    googleMcpConnectionId: normalizeEnvString(process.env.GOOGLE_MCP_CONNECTION_ID),
    googleMcpTokenRefreshUrl: normalizeEnvString(process.env.GOOGLE_MCP_TOKEN_REFRESH_URL),
    googleMcpTokenSocketPath,
    harnessId,
    homeArchiveName,
    homeDir,
    homeStorageBucketName,
    homeStoragePrefix,
    homeSyncMode,
    internalStorageDir: INTERNAL_STORAGE_DIR,
    isPrivateRuntime: isPrivateRuntimeStorageMode(runtimeStorageMode),
    legacyArchiveStorageDirs: [`${LEGACY_INTERNAL_STORAGE_DIR}/archives`],
    legacyDirectoryMarkerFiles: [LEGACY_DIRECTORY_MARKER_FILE],
    legacyInternalStorageDirs: [LEGACY_INTERNAL_STORAGE_DIR],
    mcpConfigRaw: process.env.MCP_CONFIG || "",
    ownerUid: process.env.OWNER_UID || "",
    piAgentDir,
    piMcpConfigPath,
    piHomeDir,
    piMcpAdapterPath,
    piMcpAdapterVersion: PI_MCP_ADAPTER_VERSION,
    piSessionDir,
    piSessionJsonlPath: normalizeEnvString(process.env.PI_SESSION_JSONL_PATH),
    piWebUiDataDir,
    piWebUiHealthIntervalMs: positiveNumber(process.env.MAPACHE_PI_WEB_UI_HEALTH_INTERVAL_MS, 100),
    piWebUiHost: "127.0.0.1",
    piWebUiPiDir,
    piWebUiPort: 8787,
    piWebUiRoot,
    piWebUiSessionDir,
    piWebUiControlPath,
    qaCase,
    qaFaultHarness,
    agentActivityPollIntervalMs: positiveNumber(process.env.MAPACHE_AGENT_ACTIVITY_POLL_INTERVAL_MS, 1000),
    agentCompletedTurnDebounceMs: positiveNumber(process.env.MAPACHE_AGENT_COMPLETED_TURN_DEBOUNCE_MS, 1000),
    agentSnapshotIntervalMs: positiveNumber(process.env.MAPACHE_AGENT_SNAPSHOT_INTERVAL_MS, 60000),
    automationExecutionPollIntervalMs: positiveNumber(process.env.MAPACHE_AUTOMATION_EXECUTION_POLL_INTERVAL_MS, 1000),
    automationExecutionStatusTimeoutMs: positiveNumber(process.env.MAPACHE_AUTOMATION_EXECUTION_STATUS_TIMEOUT_MS, 5000),
    manualSaveBudgetMs: positiveNumber(process.env.MAPACHE_MANUAL_SAVE_BUDGET_MS, 120000),
    sigtermSaveBudgetMs: positiveNumber(process.env.MAPACHE_SIGTERM_SAVE_BUDGET_MS, 8000),
    piWebUiQuiesceTimeoutMs: positiveNumber(process.env.MAPACHE_PI_WEB_UI_QUIESCE_TIMEOUT_MS, 5000),
    piWebUiStartupTimeoutMs: positiveNumber(process.env.MAPACHE_PI_WEB_UI_STARTUP_TIMEOUT_MS, 30000),
    piWebUiStopTimeoutMs: positiveNumber(process.env.MAPACHE_PI_WEB_UI_STOP_TIMEOUT_MS, 5000),
    piSessionStorageBucket,
    piSessionStoragePrefix,
    port: Number(process.env.PORT || 8080),
    privateGitDir,
    privateRuntimeRoot: privatePaths?.runtimeRoot || "",
    prefix,
    previewBasePath,
    previewConfigPath: path.join(workspaceDir, ".mapache", "preview.json"),
    previewEnabled,
    previewInjectLogger: previewEnabled && envFlag(process.env.PREVIEW_INJECT_LOGGER, true),
    previewLogLimit: positiveNumber(process.env.PREVIEW_LOG_LIMIT, 500),
    previewStaticRoot: path.resolve(process.env.PREVIEW_STATIC_ROOT || path.join(workspaceDir, "build")),
    runnerCapabilities,
    runtimeKind,
    sessionBrowserTokenSecret: normalizeEnvString(process.env.SESSION_BROWSER_TOKEN_SECRET),
    sessionId: process.env.SESSION_ID || "",
    sessionName: normalizeEnvString(process.env.SESSION_NAME) || "Terminal session",
    shutdownToken: process.env.SESSION_SHUTDOWN_TOKEN || "",
    syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 30000),
    terminalReplayLimit: positiveNumber(process.env.TERMINAL_REPLAY_LIMIT, 1000000),
    terminalKind: "pi",
    workspaceDir,
    workspaceGoogleApplicationCredentials: normalizeEnvString(workspaceGoogleApplicationCredentials),
    workspaceId: process.env.WORKSPACE_ID || "",
    workspaceSourceMode,
    workspaceStorageGeneration: normalizeEnvString(process.env.WORKSPACE_STORAGE_GENERATION),
    workspaceStorageMode,
    workspaceStorageReadyMarker: normalizeEnvString(process.env.WORKSPACE_STORAGE_READY_MARKER) || SHARED_WORKSPACE_READY_MARKER,
    workspaceSyncRole,
    workspaceSyncPolicyExclude,
    workspaceSyncPolicyMode,
    runtimeIdentity,
    runtimeStorageMode,
  };
}

module.exports = {
  createConfig,
  normalizePreviewBasePath,
  normalizeWorkspaceSourceMode,
  normalizeWorkspaceSyncRole,
  parseRunnerCapabilities,
};
