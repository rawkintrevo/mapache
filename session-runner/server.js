"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const {WebSocketServer} = require("ws");
const {createActivityService} = require("./lib/activity");
const {createConfig} = require("./lib/config");
const {createGitService} = require("./lib/git");
const {createPiService, sendPiPackageError, sendPiSkillError} = require("./lib/pi");
const {createPreviewService} = require("./lib/preview");
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
const git = createGitService({config, activity});
const preview = createPreviewService(config);
const workspace = createWorkspaceService({admin, config, db, git, storage});
const pi = createPiService({config, syncUp: workspace.syncUp});
const terminalSession = createTerminalSession({admin, config, activity});

app.use(express.json());
app.use(
    "/xterm",
    express.static(path.join(__dirname, "node_modules", "@xterm", "xterm")),
);

app.get("/", (req, res) => {
  res.type("html").send(renderTerminalPage());
});

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    workspaceId: config.workspaceId,
    sessionId: config.sessionId,
    bucketName: config.bucketName,
    prefix: config.prefix,
  });
});

app.get("/capabilities", (req, res) => {
  res.json({
    ok: true,
    capabilities: config.runnerCapabilities,
    preview: preview.capabilityStatus(),
  });
});

if (config.previewEnabled) {
  app.get(`${config.previewBasePath}/status`, async (req, res) => {
    res.json(await preview.status());
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

app.get("/pi/skills", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await pi.withSkillOperationLock({read: true}, pi.listWorkspacePiSkills));
  } catch (error) {
    sendPiSkillError(res, error, "pi_skill_list_failed");
  }
});

app.post("/pi/skills", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await pi.withSkillOperationLock({read: false}, () => pi.saveWorkspacePiSkill(req.body || {})));
  } catch (error) {
    sendPiSkillError(res, error, "pi_skill_save_failed");
  }
});

app.post("/pi/skills/delete", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    res.json(await pi.withSkillOperationLock({read: false}, () => pi.deleteWorkspacePiSkill(req.body || {})));
  } catch (error) {
    sendPiSkillError(res, error, "pi_skill_delete_failed");
  }
});

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
  await handleGitAction(req, res, "git push failed", "git_push_failed", () => git.pushGitChanges(), {
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
      await workspace.synchronizePiAuth({materialize: true});
      await pi.seedDefaultRuntimeSkills();
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
