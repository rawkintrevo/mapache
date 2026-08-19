"use strict";

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
const {createMcpConfigService} = require("./lib/mcpConfig.service");
const {createPreviewService} = require("./lib/preview");
const {createSshSessionService} = require("./lib/sshSession");
const {admin, db, storage} = require("./lib/services");
const {
  createTerminalSession,
  renderTerminalPage,
  shouldReplayTerminal,
} = require("./lib/terminal");
const {compactErrorMessage} = require("./lib/utils");
const {createWorkspaceService} = require("./lib/workspace");
const {createWorkspaceSyncCoordinator} = require("./lib/workspaceSyncCoordinator");
const {createWebSocketUpgradeRouter} = require("./lib/webSocketUpgrade");
const {createRunnerLifecycleCoordinator} = require("./lib/runnerLifecycle");
const {registerAgentRoutes} = require("./routes/agentRoutes");
const {registerBrowserRoutes, registerPreviewRoutes} = require("./routes/browserPreviewRoutes");
const {registerGitRoutes} = require("./routes/gitRoutes");
const {registerSshRoutes} = require("./routes/sshRoutes");
const {registerWorkspaceRoutes} = require("./routes/workspaceRoutes");

const config = createConfig();
const browserAccess = createBrowserAccessVerifier({
  secret: config.sessionBrowserTokenSecret,
  sessionId: config.sessionId,
});
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({noServer: true});
const browserWss = new WebSocketServer({noServer: true});
const activity = createActivityService({admin, db, config});
const browserQa = createBrowserQaService(config);
const chromeRuntime = createChromeRuntime(config, {
  desktop: createChromeDesktopService(config),
});
const vncBridge = createVncBridge({host: config.chromeVncHost, port: config.chromeVncPort});
const codex = createCodexService({config});
const git = createGitService({config, activity});
const preview = createPreviewService(config, {browserQa});
const sshSession = createSshSessionService({config});
const workspace = createWorkspaceService({admin, config, db, git, storage});
const workspaceSync = createWorkspaceSyncCoordinator({
  syncDown: workspace.syncDown,
  syncUp: workspace.syncUp,
});
const chromeProfile = createChromeProfileService({config, archives: workspace});
const chromeProfileSnapshots = createChromeProfileSnapshotService({
  config,
  profile: chromeProfile,
  snapshot: () => workspaceSync.syncUp({includeArchives: true}),
});
const pi = createPiService({config, syncUp: workspaceSync.syncUp});
const mcpConfig = createMcpConfigService({config});
const harnesses = createRunnerHarnessRegistry({codex, config, mcpConfig, pi, workspace});
const activeHarness = harnesses.resolveHarness();
const terminalSession = createTerminalSession({
  admin,
  config,
  activity,
  onTerminalExit: async ({command, exitCode}) => {
    const executable = path.basename(String(command && command.file || ""));
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
const runnerLifecycle = createRunnerLifecycleCoordinator({
  activity,
  activeHarness,
  admin,
  chromeProfile,
  chromeProfileSnapshots,
  chromeRuntime,
  config,
  git,
  listen: (onListening) => server.listen(config.port, onListening),
  sshSession,
  workspace,
  workspaceSync,
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
});
registerSshRoutes({app, hasRunnerAccess, requireBrowserAccess, sshSession});
registerPreviewRoutes({app, browserQa, config, hasRunnerAccess, preview, requireBrowserAccess, storage});
registerWorkspaceRoutes({
  app,
  hasRunnerAccess,
  shutdown: runnerLifecycle.shutdown,
  workspaceSync,
});
registerAgentRoutes({app, hasRunnerAccess, pi, sendPiPackageError, sendPiSkillError, workspace});
registerGitRoutes({app, compactErrorMessage, config, git, hasRunnerAccess});

wss.on("connection", (socket, request) => {
  if (!hasBrowserAccess(request)) {
    socket.close(1008, "unauthorized");
    return;
  }

  terminalSession.attach(socket, shouldReplayTerminal(request));

  socket.on("message", (raw) => {
    terminalSession.handleMessage(raw);
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
  terminalWss: wss,
  browserWss,
  hasBrowserAccess,
}));

runnerLifecycle.start()
    .catch((error) => {
      console.error("session runner failed to start", error);
      process.exit(1);
    });

function hasRunnerAccess(req) {
  return Boolean(config.shutdownToken) && req.get("x-shutdown-token") === config.shutdownToken;
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
