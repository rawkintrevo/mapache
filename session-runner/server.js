"use strict";

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const {WebSocketServer} = require("ws");
const {createActivityService} = require("./lib/activity");
const {createBrowserQaService} = require("./lib/browserQa");
const {createCodexService} = require("./lib/codex");
const {createConfig} = require("./lib/config");
const {createGitService} = require("./lib/git");
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

const config = createConfig();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({server, path: "/terminal"});
const activity = createActivityService({admin, db, config});
const browserQa = createBrowserQaService(config);
const codex = createCodexService({config});
const git = createGitService({config, activity});
const preview = createPreviewService(config, {browserQa});
const sshSession = createSshSessionService({config});
const workspace = createWorkspaceService({admin, config, db, git, storage});
const pi = createPiService({config, syncUp: workspace.syncUp});
const mcpConfig = createMcpConfigService({config});
const terminalSession = createTerminalSession({
  admin,
  config,
  activity,
  onTerminalExit: async ({command, exitCode}) => {
    const executable = path.basename(String(command && command.file || ""));
    if (executable === "pi") {
      await git.finalizeGithubAutomationBranch(exitCode);
      await workspace.syncUp({includeArchives: true});
      return;
    }
    if (executable === "codex") {
      await workspace.syncUp({includeArchives: true});
    }
  },
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

app.get("/", requireBrowserAccess, (req, res) => {
  res.type("html").send(renderTerminalPage({accessToken: req.mapacheAccessToken}));
});

app.get("/healthz", requireBrowserAccess, (req, res) => {
  res.json({
    ok: true,
    workspaceId: config.workspaceId,
    sessionId: config.sessionId,
    bucketName: config.bucketName,
    prefix: config.prefix,
  });
});

app.get("/capabilities", requireBrowserAccess, async (req, res) => {
  res.json({
    ok: true,
    capabilities: config.runnerCapabilities,
    preview: preview.capabilityStatus(),
  });
});

app.get("/ssh/files", async (req, res) => {
  if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
  if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
  try {
    res.json(await sshSession.listFiles());
  } catch (error) {
    console.error("ssh file list failed", error);
    res.status(error.status || 502).json({error: error.publicMessage || error.message || "ssh_file_list_failed"});
  }
});

app.get("/ssh/file", async (req, res) => {
  if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
  if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
  try {
    res.json(await sshSession.readFile(req.query.path || ""));
  } catch (error) {
    console.error("ssh file read failed", error);
    res.status(error.status || 502).json({error: error.publicMessage || error.message || "ssh_file_read_failed"});
  }
});

app.put("/ssh/file", async (req, res) => {
  if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
  if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
  try {
    res.json(await sshSession.saveFile(req.query.path || "", String((req.body || {}).content || "")));
  } catch (error) {
    console.error("ssh file save failed", error);
    res.status(error.status || 502).json({error: error.publicMessage || error.message || "ssh_file_save_failed"});
  }
});

app.get("/ssh/ports", async (req, res) => {
  if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
  if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
  res.json({ok: true, forwards: sshSession.listForwards()});
});

app.post("/ssh/ports", async (req, res) => {
  if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
  if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
  try {
    res.status(201).json(await sshSession.createForward((req.body || {}).port));
  } catch (error) {
    console.error("ssh forward create failed", error);
    res.status(error.status || 502).json({error: error.publicMessage || error.message || "ssh_forward_create_failed"});
  }
});

app.delete("/ssh/ports/:port", async (req, res) => {
  if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
  if (!sshSession.enabled()) return res.status(400).json({error: "ssh_session_required"});
  try {
    res.json(sshSession.closeForward(req.params.port));
  } catch (error) {
    res.status(error.status || 400).json({error: error.message || "ssh_forward_close_failed"});
  }
});

app.use("/ssh/forward/:port", requireBrowserAccess);
app.all("/ssh/forward/:port/*", (req, res) => sshSession.proxyForward(req, res, req.params.port));
app.all("/ssh/forward/:port", (req, res) => sshSession.proxyForward(req, res, req.params.port));

if (config.previewEnabled) {
  app.post(`${config.previewBasePath}/share`, async (req, res) => {
    if (!hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }

    try {
      res.json(await preview.shareStaticBuild(storage, req.body || {}));
    } catch (error) {
      console.error("preview share failed", error);
      res.status(error.status || 500).json({error: error.publicMessage || "preview_share_failed"});
    }
  });

  app.use(config.previewBasePath, requireBrowserAccess);

  app.get(`${config.previewBasePath}/status`, async (req, res) => {
    res.json(await preview.status());
  });

  app.get(`${config.previewBasePath}/qa/status`, async (req, res) => {
    const previewStatus = await preview.status();
    res.json({
      ok: true,
      qa: previewStatus.qa || browserQa.status(previewStatus),
    });
  });

  app.get(`${config.previewBasePath}/logs`, (req, res) => {
    res.json({ok: true, logs: preview.logs});
  });

  app.post(`${config.previewBasePath}/logs`, (req, res) => {
    const entry = preview.appendLog(req.body || {});
    res.json({ok: true, entry});
  });

  app.get(`${config.previewBasePath}/logs/stream`, (req, res) => {
    preview.streamLogs(req, res);
  });

  app.all(`${config.previewBasePath}/*`, async (req, res) => {
    await preview.serve(req, res);
  });

  app.get(config.previewBasePath, (req, res) => {
    res.redirect(`${config.previewBasePath}/`);
  });

  app.all(config.previewBasePath, async (req, res) => {
    await preview.serve(req, res);
  });
}

app.post("/shutdown", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    sshSession.closeAll();
    await workspace.syncUp({includeArchives: true});
    await activity.updateSessionActivity({
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      shutdownRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ok: true});
  } catch (error) {
    console.error("shutdown sync failed", error);
    res.status(500).json({error: "shutdown_sync_failed"});
  }
});

app.get("/git/status", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  if (git.isBlankWorkspace()) {
    res.json({ok: true, git: false, sourceType: config.workspaceSourceMode, reason: "not_git_workspace"});
    return;
  }

  try {
    res.json(await git.getGitStatusSummary());
  } catch (error) {
    console.error("git status failed", error);
    res.status(500).json({error: "git_status_failed"});
  }
});

app.post("/pi/auth/materialize", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await workspace.materializePiAuthNow(req.body && req.body.selection));
  } catch (error) {
    console.error("pi auth materialize failed", error);
    res.status(500).json({error: "pi_auth_materialize_failed"});
  }
});

app.get("/pi/packages", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await pi.withPackageOperationLock({read: true}, pi.listWorkspacePiPackages));
  } catch (error) {
    sendPiPackageError(res, error, "pi_package_list_failed");
  }
});

app.post("/pi/packages/install", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await pi.withPackageOperationLock({read: false}, () => pi.installWorkspacePiPackage(req.body || {})));
  } catch (error) {
    sendPiPackageError(res, error, "pi_package_install_failed");
  }
});

app.post("/pi/packages/remove", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await pi.withPackageOperationLock({read: false}, () => pi.removeWorkspacePiPackage(req.body || {})));
  } catch (error) {
    sendPiPackageError(res, error, "pi_package_remove_failed");
  }
});

app.post("/pi/packages/update", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await pi.withPackageOperationLock({read: false}, () => pi.updateWorkspacePiPackages(req.body || {})));
  } catch (error) {
    sendPiPackageError(res, error, "pi_package_update_failed");
  }
});

async function handleWorkspaceSkillList(req, res) {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await pi.withSkillOperationLock({read: true}, pi.listWorkspaceSkills));
  } catch (error) {
    sendPiSkillError(res, error, "pi_skill_list_failed");
  }
}

async function handleWorkspaceSkillSave(req, res) {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await pi.withSkillOperationLock({read: false}, () => pi.saveWorkspaceSkill(req.body || {})));
  } catch (error) {
    sendPiSkillError(res, error, "pi_skill_save_failed");
  }
}

async function handleWorkspaceSkillDelete(req, res) {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await pi.withSkillOperationLock({read: false}, () => pi.deleteWorkspaceSkill(req.body || {})));
  } catch (error) {
    sendPiSkillError(res, error, "pi_skill_delete_failed");
  }
}

app.get("/skills", handleWorkspaceSkillList);
app.post("/skills", handleWorkspaceSkillSave);
app.post("/skills/delete", handleWorkspaceSkillDelete);
app.get("/pi/skills", handleWorkspaceSkillList);
app.post("/pi/skills", handleWorkspaceSkillSave);
app.post("/pi/skills/delete", handleWorkspaceSkillDelete);

app.post("/git/pull", async (req, res) => {
  await handleGitAction(req, res, "git pull failed", "git_pull_failed", () => git.pullGitAction(), {
    statusCode: 500,
  });
});

app.post("/git/stage", async (req, res) => {
  await handleGitAction(req, res, "git stage failed", "git_stage_failed", () => git.stageGitPaths(req.body || {}));
});

app.post("/git/unstage", async (req, res) => {
  await handleGitAction(req, res, "git unstage failed", "git_unstage_failed", () => git.unstageGitPaths(req.body || {}));
});

app.post("/git/commit", async (req, res) => {
  await handleGitAction(req, res, "git commit failed", "git_commit_failed", () => git.commitGitChanges(req.body || {}), {
    compactError: true,
  });
});

app.post("/git/push", async (req, res) => {
  await handleGitAction(req, res, "git push failed", "git_push_failed", () => git.pushGitChanges(req.body || {}), {
    compactError: true,
  });
});

app.post("/git/open-pr", async (req, res) => {
  await handleGitAction(
      req,
      res,
      "git open pr prepare failed",
      "git_open_pr_failed",
      () => git.prepareGitPullRequest(req.body || {}),
      {compactError: true},
  );
});

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

workspace.ensureWorkspace()
    .then(async () => {
      console.log(`workspace source mode: ${config.workspaceSourceMode}, sync policy mode: ${config.workspaceSyncPolicyMode}`);
      await workspace.prepareWorkspaceSource();
      await mcpConfig.materializeMcpConfig();
      if (config.terminalKind === "pi") {
        await workspace.synchronizePiAuth({materialize: true});
      }
      await git.prepareGithubAutomationBranch();
      if (config.terminalKind === "pi") {
        await pi.seedDefaultRuntimeSkills();
      }
      if (config.terminalKind === "codex") {
        await codex.seedDefaultWorkspaceFiles();
      }
    })
    .then(() => {
      startSyncLoop();
      server.listen(config.port, () => {
        console.log(`session runner listening on ${config.port}`);
      });
    })
    .catch((error) => {
      console.error("session runner failed to start", error);
      process.exit(1);
    });

async function handleGitAction(req, res, logMessage, fallbackCode, action, options = {}) {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }
  if (git.isBlankWorkspace()) {
    res.json({ok: true, git: false, sourceType: config.workspaceSourceMode, reason: "not_git_workspace"});
    return;
  }

  try {
    res.json(await action());
  } catch (error) {
    console.error(logMessage, error);
    const responseCode = options.compactError ? compactErrorMessage(error.message || error) || fallbackCode : fallbackCode;
    res.status(options.statusCode || 400).json({error: responseCode});
  }
}

function startSyncLoop() {
  let lastArchiveSync = 0;
  let syncUpRunning = false;
  setInterval(() => {
    if (syncUpRunning) return;
    syncUpRunning = true;
    const now = Date.now();
    const includeArchives = now - lastArchiveSync >= config.archiveSyncIntervalMs;
    workspace.syncUp({includeArchives})
        .then(() => {
          if (includeArchives) lastArchiveSync = now;
        })
        .catch((error) => console.error("sync up failed", error))
        .finally(() => {
          syncUpRunning = false;
        });
  }, config.syncIntervalMs);
}

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
      sameSite: "none",
      secure: true,
    });
  }
  next();
}

function hasBrowserAccess(req) {
  const token = browserAccessToken(req);
  if (!token || !verifyBrowserAccessToken(token)) return false;
  req.mapacheAccessToken = token;
  return true;
}

function browserAccessToken(req) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const queryToken = url.searchParams.get("mapache_access");
    if (queryToken) return queryToken;
  } catch (error) {
    return "";
  }

  const cookie = req.headers && req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)mapache_access=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function verifyBrowserAccessToken(token) {
  if (!config.sessionBrowserTokenSecret) return false;
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expected = crypto
      .createHmac("sha256", config.sessionBrowserTokenSecret)
      .update(parts[0])
      .digest("base64url");
  if (!timingSafeEqual(parts[1], expected)) return false;

  const payload = parseBrowserAccessPayload(parts[0]);
  if (!payload || payload.sid !== config.sessionId) return false;
  return Number(payload.exp || 0) > Math.floor(Date.now() / 1000);
}

function parseBrowserAccessPayload(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (error) {
    return null;
  }
}

function browserAccessTokenMaxAgeMs(token) {
  const payload = parseBrowserAccessPayload(String(token || "").split(".")[0] || "");
  const expMs = Number(payload && payload.exp || 0) * 1000;
  return Math.max(0, Math.min(expMs - Date.now(), 24 * 60 * 60 * 1000));
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
