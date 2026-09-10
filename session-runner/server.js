"use strict";

const {isolateRunnerGoogleCredentials} = require("./lib/runnerEnvironment");
const runnerEnvironment = isolateRunnerGoogleCredentials();
const crypto = require("node:crypto");
const path = require("path");
const http = require("http");
const express = require("express");
const {createVncBridge} = require("./lib/vncBridge");
const {WebSocketServer} = require("ws");
const {createActivityService} = require("./lib/activity");
const {browserVncWebSocketPath, createBrowserAccessVerifier} = require("./lib/browserAccess");
const {createBrowserQaService} = require("./lib/browserQa");
const {createChromeRuntime} = require("./lib/chromeRuntime");
const {createChromeDesktopService} = require("./lib/chromeDesktop");
const {createChromeProfileService} = require("./lib/chromeProfile.service");
const {createChromeProfileSnapshotService} = require("./lib/chromeProfileSnapshot.service");
const {createCodexService} = require("./lib/codex");
const {createConfig} = require("./lib/config");
const {createGitService} = require("./lib/git");
const {createRunnerHarnessRegistry} = require("./lib/harnesses");
const {createPiService, sendPiPackageError, sendPiSkillError} = require("./lib/pi");
const {createPiModelScopeService} = require("./lib/piModelScope.service");
const {createPiChatTranscriptService} = require("./lib/piChat.service");
const {createPiChatWebSocket} = require("./lib/piChatWebSocket");
const {createMcpConfigService} = require("./lib/mcpConfig.service");
const {createGoogleMcpStatusService} = require("./lib/googleMcpStatus.service");
const {createPreviewService} = require("./lib/preview");
const {createResourceMetricsService} = require("./lib/resourceMetrics.service");
const {createResourceMetricsWebSocket} = require("./lib/resourceMetricsWebSocket");
const {createSshSessionService} = require("./lib/sshSession");
const {admin, db, storage} = require("./lib/services");
const {
  createTerminalSession,
  renderTerminalPage,
  shouldReplayTerminal,
} = require("./lib/terminal");
const {createShellSession} = require("./lib/shell");
const {compactErrorMessage} = require("./lib/utils");
const {createWorkspaceService} = require("./lib/workspace");
const {createWorkspaceSyncCoordinator} = require("./lib/workspaceSyncCoordinator");
const {createWebSocketUpgradeRouter} = require("./lib/webSocketUpgrade");
const {createControlManager} = require("./lib/controlManager");
const {createExecutionAuthority} = require("./lib/executionAuthority");
const {createMutationBarrier} = require("./lib/mutationBarrier");
const {createProcessSupervisor} = require("./lib/processSupervisor");
const {createPiWebFirstAdapter} = require("./lib/piWebFirstAdapter");
const {createWebFirstAgentGateway} = require("./lib/webFirstAgent");
const {createWorkspaceCheckpointService} = require("./lib/workspaceCheckpoint.service");
const {createRunnerLifecycleCoordinator} = require("./lib/runnerLifecycle");
const {registerAgentRoutes} = require("./routes/agentRoutes");
const {registerBrowserRoutes, registerPreviewRoutes} = require("./routes/browserPreviewRoutes");
const {registerGitRoutes} = require("./routes/gitRoutes");
const {registerGoogleMcpRoutes} = require("./routes/googleMcpRoutes");
const {registerSshRoutes} = require("./routes/sshRoutes");
const {registerWorkspaceRoutes} = require("./routes/workspaceRoutes");
const {registerGoalsRoutes} = require("./routes/goalsRoutes");
const {createGoalsBridgeService} = require("./lib/goalsProtocol");
const {createGoalsRpcService} = require("./lib/goalsRpc.service");
const {createGoalsPackageBootstrap} = require("./lib/goalsPackageBootstrap");

const config = createConfig(runnerEnvironment);
const browserAccess = createBrowserAccessVerifier({
  secret: config.sessionBrowserTokenSecret,
  sessionId: config.sessionId,
});
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({noServer: true});
const browserWss = new WebSocketServer({noServer: true});
const shellWss = new WebSocketServer({noServer: true});
const webFirstRuntimeId = config.webFirstEnabled ? `runtime-${crypto.randomUUID()}` : null;
const webFirstControlManager = config.webFirstEnabled ? createControlManager({
  runtimeId: webFirstRuntimeId,
  executionEpoch: Date.now(),
  sessionGeneration: 1,
  heartbeatMs: config.webFirstHeartbeatMs,
  leaseMs: config.webFirstLeaseMs,
}) : null;
const mutationBarrier = createMutationBarrier({timeoutMs: config.checkpointBarrierTimeoutMs || undefined});
const processSupervisor = createProcessSupervisor();
let webFirstAgent = null;
let terminalSession = null;
let shellSession = null;
let workspaceSync = null;
let goalsPackage = null;
let workspaceCheckpoint = null;
const beforeIndependentMutation = async (label) => {
  if (!config.webFirstEnabled) return;
  const excludedFromWorkspaceRecovery = ["auth_materialize", "pi_model_scope_save", "pi_models_file_save"].includes(label);
  if (excludedFromWorkspaceRecovery) {
    executionAuthority.assertAuthority();
    return;
  }
  await workspaceCheckpoint?.assertMutationAllowed?.({requireSession: true});
};
const afterIndependentMutation = async (label) => {
  if (!config.webFirstEnabled) return;
  await workspaceCheckpoint?.create?.({reason: label || "independent_mutation"});
};
const executionAuthority = createExecutionAuthority({
  admin,
  config,
  db,
  runtimeId: webFirstRuntimeId || undefined,
  leaseMs: config.webFirstLeaseMs || undefined,
  renewIntervalMs: config.webFirstRenewIntervalMs || undefined,
  onLost: async (info) => {
    mutationBarrier.fence(info.reason);
    workspaceSync?.fence?.(info.reason);
    webFirstAgent?.fence?.(info.reason);
    terminalSession?.fence?.(info.reason);
    shellSession?.fence?.(info.reason);
    processSupervisor.fence();
    await processSupervisor.stopAll(info.reason).catch((error) => {
      console.error("controlled process termination unresolved", error);
    });
    try {
      await goalsPackage?.stop?.();
    } catch (error) {
      console.error("managed goal stop after execution fence failed", error);
    }
    try {
      await chromeRuntime?.stop?.();
    } catch (error) {
      console.error("Chrome runtime stop after execution fence failed", error);
    }
    await activity.updateSessionActivity({
      runtimeState: "fenced",
      runtimeLastError: String(info.reason || "execution_authority_lost").slice(0, 512),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  },
});
const activity = createActivityService({admin, db, config});
const browserQa = createBrowserQaService(config);
const chromeRuntime = createChromeRuntime(config, {
  desktop: createChromeDesktopService(config),
});
const vncBridge = createVncBridge({host: config.chromeVncHost, port: config.chromeVncPort});
const codex = createCodexService({config});
const git = createGitService({config, activity, mutationBarrier, executionAuthority, beforeMutation: beforeIndependentMutation, afterMutation: afterIndependentMutation});
const preview = createPreviewService(config, {browserQa});
const sshSession = createSshSessionService({config});
const workspace = createWorkspaceService({admin, config, db, git, storage});
workspaceSync = createWorkspaceSyncCoordinator({
  syncDown: workspace.syncDown,
  syncUp: workspace.syncUp,
  syncChromeProfileUp: workspace.syncChromeProfileUp,
  syncWriterRole: config.workspaceSyncRole,
  mutationBarrier,
  executionAuthority,
  webFirstEnabled: config.webFirstEnabled,
});
const chromeProfile = createChromeProfileService({config, archives: workspace});
const chromeProfileSnapshots = createChromeProfileSnapshotService({
  config,
  profile: chromeProfile,
  snapshot: () => workspaceSync.syncChromeProfileUp(),
});
const pi = createPiService({config, syncUp: workspaceSync.syncUp, mutationBarrier, executionAuthority, beforeMutation: beforeIndependentMutation, afterMutation: afterIndependentMutation});
const piModelScope = createPiModelScopeService({admin, config, db, mutationBarrier, executionAuthority});
const mcpConfig = createMcpConfigService({config});
const googleMcpStatus = createGoogleMcpStatusService({config});
const harnesses = createRunnerHarnessRegistry({codex, config, mcpConfig, pi, workspace});
const activeHarness = harnesses.resolveHarness();
let goalsRpc = null;
terminalSession = createTerminalSession({
  admin,
  config,
  activity,
  canStartProcess: () => !goalsRpc?.isActive?.() && executionAuthority.canMutate(),
  controlManager: webFirstControlManager,
  mutationBarrier,
  executionAuthority,
  processSupervisor,
  webFirstEnabled: config.webFirstEnabled,
  onTerminalExit: async ({command, exitCode}) => {
    const executable = path.basename(String(command && command.file || ""));
    if (config.webFirstEnabled) {
      await workspaceCheckpoint?.create?.({reason: "terminal_exit"});
      return;
    }
    if (executable === "pi") {
      await git.finalizeGithubAutomationBranch(exitCode);
      await workspaceSync.syncUp({includeArchives: true});
      return;
    }
    if (executable === "codex") {
      await workspaceSync.syncUp({includeArchives: true});
    }
  },
});
const webFirstAdapter = config.webFirstEnabled ? createPiWebFirstAdapter({
  socketPath: config.webFirstAdapterSocket,
  timeoutMs: config.webFirstAdapterTimeoutMs,
}) : null;
webFirstAgent = config.webFirstEnabled ? createWebFirstAgentGateway({
  adapter: webFirstAdapter,
  config,
  controlManager: webFirstControlManager,
  runtimeId: webFirstRuntimeId,
  terminalSession,
  mutationBarrier,
  executionAuthority,
}) : null;
shellSession = createShellSession({
  admin,
  config,
  activity,
  controlManager: webFirstControlManager,
  mutationBarrier,
  executionAuthority,
  processSupervisor,
  webFirstEnabled: config.webFirstEnabled,
});
goalsRpc = createGoalsRpcService({config: {...config, webFirstEnabled: config.webFirstEnabled}, terminalSession, processSupervisor});
const goalsBridge = createGoalsBridgeService({config: {...config, webFirstEnabled: config.webFirstEnabled}, terminalSession, rpcService: goalsRpc});
const goalsPackageBootstrap = createGoalsPackageBootstrap({config, version: process.env.PI_GOAL_X_VERSION || undefined});
goalsPackage = {
  ensureInstalledDeclaration: goalsPackageBootstrap.ensureInstalledDeclaration,
  setBridgeAvailability: (value) => goalsBridge.setPackageAvailable(value),
  stop: () => goalsBridge.stop(),
};
const piChatTranscript = createPiChatTranscriptService({config});
const piChat = createPiChatWebSocket({
  config,
  hasBrowserAccess,
  terminalSession,
  transcriptService: piChatTranscript,
  webFirstEnabled: config.webFirstEnabled,
  webFirstGateway: webFirstAgent,
});
workspaceCheckpoint = config.webFirstEnabled ? createWorkspaceCheckpointService({
  admin,
  config,
  db,
  storage,
  authority: executionAuthority,
  barrier: mutationBarrier,
  ledger: webFirstAgent.operationLedger,
  adapter: webFirstAdapter,
  goals: goalsBridge,
  isQuiescent: async () => {
    const snapshot = await webFirstAgent.snapshot();
    return !snapshot.control?.activeRun;
  },
  barrierTimeoutMs: config.checkpointBarrierTimeoutMs,
  orphanGraceMs: config.checkpointOrphanGraceMs,
}) : null;
webFirstAgent?.setCheckpointService?.(workspaceCheckpoint);
const resourceMetrics = createResourceMetricsService({intervalMs: config.resourceMetricsIntervalMs});
const resourceMetricsSocket = createResourceMetricsWebSocket({
  hasBrowserAccess,
  metricsService: resourceMetrics,
});
const runnerLifecycle = createRunnerLifecycleCoordinator({
  activity,
  activeHarness,
  admin,
  chromeProfile,
  chromeProfileSnapshots,
  chromeRuntime,
  config,
  executionAuthority,
  git,
  goalsPackage,
  listen: (onListening) => server.listen(config.port, onListening),
  piChat,
  resourceMetrics: resourceMetricsSocket,
  piModelScope,
  sshSession,
  workspace,
  workspaceSync,
  checkpoint: workspaceCheckpoint,
  webFirst: webFirstAgent,
});

app.use(express.json());
app.use(
    "/xterm",
    express.static(path.join(__dirname, "node_modules", "@xterm", "xterm")),
);
app.use(
    "/xterm-fit",
    express.static(path.join(__dirname, "node_modules", "@xterm", "addon-fit")),
);

registerBrowserRoutes({
  activity,
  admin,
  app,
  browserVncWebSocketPath,
  chromeRuntime,
  config,
  expressStatic: express.static,
  preview,
  requireBrowserAccess,
  requireBrowserOrRunnerAccess,
  renderTerminalPage,
  webFirstEnabled: config.webFirstEnabled,
});
registerSshRoutes({app, hasRunnerAccess, requireBrowserAccess, sshSession});
registerPreviewRoutes({app, browserQa, config, hasRunnerAccess, preview, requireBrowserAccess, storage});
registerWorkspaceRoutes({
  app,
  hasRunnerAccess,
  shutdown: runnerLifecycle.shutdown,
  workspaceSync,
  executionAuthority,
  checkpoint: workspaceCheckpoint,
  beforeMutation: beforeIndependentMutation,
  afterMutation: afterIndependentMutation,
});
registerGoalsRoutes({app, goalsBridge, hasRunnerAccess});
registerAgentRoutes({app, hasRunnerAccess, pi, piModelScope, sendPiPackageError, sendPiSkillError, workspace, beforeMutation: beforeIndependentMutation});
registerGitRoutes({app, compactErrorMessage, config, git, hasRunnerAccess});
registerGoogleMcpRoutes({app, googleMcpStatus: googleMcpStatus.status, hasRunnerAccess});

wss.on("connection", (socket, request) => {
  if (!hasBrowserAccess(request)) {
    socket.close(1008, "unauthorized");
    return;
  }

  try {
    terminalSession.attach(socket, shouldReplayTerminal(request));
  } catch (error) {
    socket.close(1013, error?.code === "goal_rpc_process_active" ? "goal_running_in_web_ui" : "terminal_unavailable");
    return;
  }

  socket.on("message", (raw) => {
    terminalSession.handleMessage(raw, socket);
  });

  socket.on("close", () => {
    terminalSession.detach(socket);
  });
});

browserWss.on("connection", (socket) => {
  const bridge = vncBridge.attach(socket);
  socket.once("close", bridge.close);
});

server.on("upgrade", createWebSocketUpgradeRouter({
  agentWss: webFirstAgent?.server,
  chatWss: piChat.server,
  metricsWss: resourceMetricsSocket.server,
  shellWss,
  terminalWss: wss,
  browserWss,
  hasBrowserAccess,
  hasAgentAccess,
  hasChatAccess: (request) => piChat.supported && hasBrowserAccess(request),
  hasMetricsAccess: hasBrowserAccess,
  hasShellAccess: hasBrowserAccess,
}));

shellWss.on("connection", (socket, request) => {
  if (!hasBrowserAccess(request)) {
    socket.close(1008, "unauthorized");
    return;
  }
  try {
    shellSession.attach(socket, shouldReplayTerminal(request));
  } catch {
    socket.close(1013, "shell_unavailable");
    return;
  }
  socket.on("message", (raw) => shellSession.handleMessage(raw, socket));
  socket.on("close", () => shellSession.detach(socket));
});

runnerLifecycle.start()
    .catch((error) => {
      console.error("session runner failed to start", error);
      process.exit(1);
    });

function hasRunnerAccess(req) {
  return Boolean(config.shutdownToken) && req.get("x-shutdown-token") === config.shutdownToken;
}

function hasAgentAccess(req) {
  if (!webFirstAgent?.supported || !hasBrowserAccess(req)) return false;
  const origin = String(req.headers?.origin || "").trim();
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const configured = config.webFirstAllowedOrigins || [];
    if (configured.length) return configured.includes(parsed.origin);
    const host = String(req.headers?.host || "").trim();
    return host && [`http://${host}`, `https://${host}`].includes(parsed.origin);
  } catch {
    return false;
  }
}

function requireBrowserAccess(req, res, next) {
  if (!hasBrowserAccess(req)) {
    res.status(404).type("text").send("not_found");
    return;
  }
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  if (req.mapacheAccessToken) {
    res.cookie("mapache_access", req.mapacheAccessToken, {
      httpOnly: true,
      maxAge: browserAccessTokenMaxAgeMs(req.mapacheAccessToken),
      partitioned: true,
      sameSite: "none",
      secure: true,
    });
  }
  next();
}

function requireBrowserOrRunnerAccess(req, res, next) {
  if (!hasBrowserAccess(req) && !hasRunnerAccess(req)) {
    res.status(404).type("text").send("not_found");
    return;
  }
  next();
}

function hasBrowserAccess(req) {
  const token = browserAccess.extractToken(req);
  if (!token || !browserAccess.verify(token)) return false;
  req.mapacheAccessToken = token;
  return true;
}

function browserAccessToken(req) {
  return browserAccess.extractToken(req);
}

function verifyBrowserAccessToken(token) {
  return browserAccess.verify(token);
}

function browserAccessTokenMaxAgeMs(token) {
  return browserAccess.maxAgeMs(token);
}
