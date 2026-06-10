"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const {spawn} = require("child_process");
const {pipeline} = require("stream/promises");
const express = require("express");
const pty = require("node-pty");
const {WebSocket, WebSocketServer} = require("ws");
const {Storage} = require("@google-cloud/storage");
const admin = require("firebase-admin");

const port = Number(process.env.PORT || 8080);
const workspaceDir = process.env.WORKSPACE_DIR || "/workspace";
const bucketName = process.env.STORAGE_BUCKET || "";
const prefix = normalizePrefix(process.env.STORAGE_PREFIX || "");
const workspaceId = process.env.WORKSPACE_ID || "";
const sessionId = process.env.SESSION_ID || "";
const shutdownToken = process.env.SESSION_SHUTDOWN_TOKEN || "";
const syncIntervalMs = Number(process.env.SYNC_INTERVAL_MS || 30000);
const archiveSyncIntervalMs = Number(process.env.ARCHIVE_SYNC_INTERVAL_MS || 300000);
const terminalReplayLimit = positiveNumber(process.env.TERMINAL_REPLAY_LIMIT, 1000000);
const directoryMarkerFile = ".mapahce-directory";
const internalStorageDir = ".mapahce-internal";
const archiveStorageDir = `${internalStorageDir}/archives`;
const activityWriteDebounceMs = positiveNumber(process.env.ACTIVITY_WRITE_DEBOUNCE_MS, 15000);
const workspaceSourceMode = normalizeWorkspaceSourceMode(process.env.WORKSPACE_SOURCE_TYPE);
const archiveSyncTargets = createArchiveSyncTargets();
const workspaceSyncPolicyMode = normalizeEnvString(process.env.WORKSPACE_SYNC_POLICY_MODE) || "blank";
const workspaceSyncPolicyExclude = parseSyncPolicyExclude(process.env.WORKSPACE_SYNC_POLICY_EXCLUDE);
const githubRepoUrl = normalizeEnvString(process.env.GITHUB_REPO_URL);
const githubRequestedBranch = normalizeEnvString(process.env.GITHUB_REQUESTED_BRANCH);
const githubRequestedCommit = normalizeEnvString(process.env.GITHUB_REQUESTED_COMMIT);

admin.initializeApp();
const db = admin.firestore();
const storage = new Storage();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({server, path: "/terminal"});
const terminalSession = createTerminalSession();

app.use(express.json());
app.use(
    "/xterm",
    express.static(path.join(__dirname, "node_modules", "@xterm", "xterm")),
);

app.get("/", (req, res) => {
  res.type("html").send(renderTerminalPage());
});

app.get("/healthz", (req, res) => {
  res.json({ok: true, workspaceId, sessionId, bucketName, prefix});
});

app.post("/shutdown", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  try {
    await syncUp({includeArchives: true});
    await updateSessionActivity({
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

  if (isBlankWorkspace()) {
    res.json({ok: true, git: false, sourceType: workspaceSourceMode, reason: "not_git_workspace"});
    return;
  }

  try {
    res.json(await getGitStatusSummary());
  } catch (error) {
    console.error("git status failed", error);
    res.status(500).json({error: "git_status_failed"});
  }
});

app.post("/git/pull", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }

  if (isBlankWorkspace()) {
    res.json({ok: true, git: false, sourceType: workspaceSourceMode, reason: "not_git_workspace"});
    return;
  }

  try {
    res.json(await pullGitAction());
  } catch (error) {
    console.error("git pull failed", error);
    res.status(500).json({error: "git_pull_failed"});
  }
});

app.post("/git/stage", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }
  if (isBlankWorkspace()) {
    res.json({ok: true, git: false, sourceType: workspaceSourceMode, reason: "not_git_workspace"});
    return;
  }

  try {
    res.json(await stageGitPaths(req.body || {}));
  } catch (error) {
    console.error("git stage failed", error);
    res.status(400).json({error: "git_stage_failed"});
  }
});

app.post("/git/unstage", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }
  if (isBlankWorkspace()) {
    res.json({ok: true, git: false, sourceType: workspaceSourceMode, reason: "not_git_workspace"});
    return;
  }

  try {
    res.json(await unstageGitPaths(req.body || {}));
  } catch (error) {
    console.error("git unstage failed", error);
    res.status(400).json({error: "git_unstage_failed"});
  }
});

app.post("/git/commit", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }
  if (isBlankWorkspace()) {
    res.json({ok: true, git: false, sourceType: workspaceSourceMode, reason: "not_git_workspace"});
    return;
  }

  try {
    res.json(await commitGitChanges(req.body || {}));
  } catch (error) {
    console.error("git commit failed", error);
    res.status(400).json({error: compactErrorMessage(error.message || error) || "git_commit_failed"});
  }
});

app.post("/git/push", async (req, res) => {
  if (!hasRunnerAccess(req)) {
    res.status(404).json({error: "not_found"});
    return;
  }
  if (isBlankWorkspace()) {
    res.json({ok: true, git: false, sourceType: workspaceSourceMode, reason: "not_git_workspace"});
    return;
  }

  try {
    res.json(await pushGitChanges());
  } catch (error) {
    console.error("git push failed", error);
    res.status(400).json({error: compactErrorMessage(error.message || error) || "git_push_failed"});
  }
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

function createTerminalSession() {
  const sockets = new Set();
  let term = null;
  let outputBuffer = "";
  let activityTimer = null;
  let pendingActivity = null;

  return {
    attach(socket, replayOutput) {
      const activeTerm = ensureTerm();
      sockets.add(socket);
      updateSocketActivity("lastConnectedAt");
      if (replayOutput && outputBuffer) {
        sendTerminalMessage(socket, {type: "data", data: outputBuffer});
      }
      return activeTerm;
    },
    detach(socket) {
      sockets.delete(socket);
      updateSocketActivity("lastDisconnectedAt");
    },
    handleMessage(raw) {
      handleTerminalMessage(ensureTerm(), raw);
      markTerminalActivity();
    },
  };

  function ensureTerm() {
    if (term) return term;

    outputBuffer = "";

    const command = terminalCommand();
    term = spawnTerminal(command);

    appendHistory("system", `opened ${command.display}`);

    term.onData((data) => {
      appendToBuffer(data);
      broadcast({type: "data", data});
      appendHistory("stdout", data);
    });

    term.onExit(({exitCode: code}) => {
      appendHistory("system", `closed with exit code ${code}`);
      broadcast({type: "exit", exitCode: code});
      closeSockets();
      term = null;
    });

    return term;
  }

  function appendToBuffer(data) {
    outputBuffer += data;
    if (outputBuffer.length > terminalReplayLimit) {
      outputBuffer = outputBuffer.slice(outputBuffer.length - terminalReplayLimit);
    }
  }

  function broadcast(message) {
    for (const socket of sockets) {
      sendTerminalMessage(socket, message);
    }
  }

  function closeSockets() {
    for (const socket of sockets) {
      socket.close();
    }
  }

  function updateSocketActivity(timestampField) {
    updateSessionActivity({
      activeSocketCount: sockets.size,
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      [timestampField]: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  function markTerminalActivity() {
    if (activityTimer) {
      pendingActivity = {
        lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      return;
    }

    updateSessionActivity({
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    activityTimer = setTimeout(() => {
      activityTimer = null;
      if (!pendingActivity) return;
      const activity = pendingActivity;
      pendingActivity = null;
      updateSessionActivity(activity);
    }, activityWriteDebounceMs);
  }
}

function hasRunnerAccess(req) {
  return Boolean(shutdownToken) && req.get("x-shutdown-token") === shutdownToken;
}

function shouldReplayTerminal(request) {
  try {
    const url = new URL(request.url, "http://localhost");
    return url.searchParams.get("replay") !== "0";
  } catch (error) {
    return true;
  }
}

function spawnTerminal(command) {
  return pty.spawn(command.file, command.args, {
    name: "xterm-256color",
    cols: 100,
    rows: 32,
    cwd: workspaceDir,
    env: {...process.env, TERM: "xterm-256color"},
  });
}

function handleTerminalMessage(term, raw) {
  try {
    const message = JSON.parse(raw.toString());
    if (message.type === "resize") {
      term.resize(Number(message.cols || 100), Number(message.rows || 32));
      return;
    }
    if (message.type === "data") {
      term.write(String(message.data || ""));
    }
  } catch (error) {
    term.write(raw.toString());
  }
}

function sendTerminalMessage(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

ensureWorkspace()
    .then(async () => {
      console.log(`workspace source mode: ${workspaceSourceMode}, sync policy mode: ${workspaceSyncPolicyMode}`);
      await prepareWorkspaceSource();
    })
    .then(() => {
      let lastArchiveSync = 0;
      let syncUpRunning = false;
      setInterval(() => {
        if (syncUpRunning) return;
        syncUpRunning = true;
        const now = Date.now();
        const includeArchives = now - lastArchiveSync >= archiveSyncIntervalMs;
        syncUp({includeArchives})
            .then(() => {
              if (includeArchives) lastArchiveSync = now;
            })
            .catch((error) => console.error("sync up failed", error))
            .finally(() => {
              syncUpRunning = false;
            });
      }, syncIntervalMs);
      server.listen(port, () => {
        console.log(`session runner listening on ${port}`);
      });
    })
    .catch((error) => {
      console.error("session runner failed to start", error);
      process.exit(1);
    });

async function ensureWorkspace() {
  await fs.promises.mkdir(workspaceDir, {recursive: true});
  await Promise.all(archiveSyncTargets
      .filter((target) => target.ensureLocalPath)
      .map((target) => fs.promises.mkdir(target.localPath, {recursive: true})));
}

function createArchiveSyncTargets() {
  const targets = [
    {
      name: "workspace-node-modules",
      mode: "workspaceNodeModules",
      localPath: workspaceDir,
      remotePath: archiveRemotePath("workspace-node_modules.tar.gz"),
      ensureLocalPath: true,
      restoreOnStartup: true,
    },
    {
      name: "root-pi",
      mode: "directory",
      localPath: process.env.PI_HOME_DIR || "/root/.pi",
      remotePath: archiveRemotePath("root-pi.tar.gz"),
      ensureLocalPath: true,
      restoreOnStartup: true,
    },
  ];

  if (isGithubWorkspace()) {
    targets.push({
      name: "workspace-git",
      mode: "workspaceGit",
      localPath: path.join(workspaceDir, ".git"),
      remotePath: archiveRemotePath("workspace-git.tar.gz"),
      ensureLocalPath: false,
      restoreOnStartup: true,
    });
  }

  return targets;
}

function normalizeWorkspaceSourceMode(value) {
  return String(value || "blank").trim().toLowerCase() === "github" ? "github" : "blank";
}

function isGithubWorkspace() {
  return workspaceSourceMode === "github";
}

function isBlankWorkspace() {
  return workspaceSourceMode !== "github";
}

async function prepareWorkspaceSource() {
  if (isBlankWorkspace()) {
    await syncDown();
    return;
  }

  await emptyWorkspaceDir(workspaceDir);

  let restoredGitArchive = false;
  try {
    restoredGitArchive = await restoreGithubGitArchiveIfPresent();
    if (!restoredGitArchive) {
      await cloneGithubWorkspace();
    }
  } catch (error) {
    const handler = restoredGitArchive ? recordGithubSyncFailure : recordGithubCloneFailure;
    await handler(error);
    const label = restoredGitArchive ?
      "GitHub workspace cache restore failed" :
      "GitHub workspace startup failed";
    throw new Error(`${label}: ${compactErrorMessage(error.message || error)}`);
  }

  try {
    await syncWorktreeDown();
    await syncArchivesDown({excludeModes: ["workspaceGit"]});
    const resolved = await resolveGitHead();
    console.log(`github workspace ready at ${resolved.commit}${resolved.branch ? ` on ${resolved.branch}` : ""}`);
    await publishGithubResolvedMetadata(resolved);
  } catch (error) {
    await recordGithubSyncFailure(error);
    throw new Error(`GitHub workspace cache restore failed: ${compactErrorMessage(error.message || error)}`);
  }
}

async function restoreGithubGitArchiveIfPresent() {
  const target = archiveSyncTargets.find((item) => item.mode === "workspaceGit");
  if (!target || !bucketName || !prefix) return false;

  const file = storage.bucket(bucketName).file(target.remotePath);
  const [exists] = await file.exists();
  if (!exists) {
    console.log("no cached .git archive found; falling back to clone");
    return false;
  }

  console.log("restoring cached .git archive");
  try {
    await fs.promises.mkdir(target.localPath, {recursive: true});
    await extractStorageArchive(file, target);
    return true;
  } catch (error) {
    throw new Error(`git archive restore failed: ${compactErrorMessage(error.message || error)}`);
  }
}

async function cloneGithubWorkspace() {
  if (!githubRepoUrl) {
    throw new Error("missing GitHub repo URL for workspace startup");
  }

  console.log(`cloning GitHub workspace from ${githubRepoUrl}`);
  await runGitClone();
  await checkoutRequestedCommit();
}

async function runGitClone() {
  const args = ["clone"];
  if (!githubRequestedCommit && githubRequestedBranch) {
    args.push("--branch", githubRequestedBranch, "--single-branch");
  }
  args.push(githubRepoUrl, workspaceDir);
  try {
    await runGitCommand(args, {cwd: "/"});
  } catch (error) {
    throw new Error(`clone failed: ${compactErrorMessage(error.message || error)}`);
  }
}

async function checkoutRequestedCommit() {
  if (!githubRequestedCommit) return;
  console.log(`checking out requested commit ${githubRequestedCommit}`);
  try {
    await runGitCommand(["checkout", "--force", githubRequestedCommit]);
  } catch (error) {
    throw new Error(`checkout failed: ${compactErrorMessage(error.message || error)}`);
  }
}

async function resolveGitHead() {
  const commit = await runGitCommand(["rev-parse", "HEAD"], {captureStdout: true});
  const branch = await runGitCommand(["branch", "--show-current"], {captureStdout: true});
  return {
    branch: branch || null,
    commit: commit || githubRequestedCommit || null,
  };
}

async function recordGithubCloneFailure(error) {
  const message = compactErrorMessage(error && error.message ? error.message : error);
  console.error("github workspace clone failed", message);
  await publishGithubFailureState("clone_failed", message, `github_clone_failed: ${message}`);
}

async function recordGithubSyncFailure(error) {
  const message = compactErrorMessage(error && error.message ? error.message : error);
  console.error("github workspace cache restore failed", message);
  await publishGithubFailureState("sync_failed", message, `github_sync_failed: ${message}`);
}

async function publishGithubResolvedMetadata(resolved) {
  await Promise.all([
    updateSessionActivity({
      sourceResolvedBranch: resolved.branch,
      sourceResolvedCommit: resolved.commit,
      sourceStatus: "ready",
      sourceStatusMessage: null,
      lastError: null,
    }),
    updateWorkspaceSourceState({
      resolvedBranch: resolved.branch,
      resolvedCommit: resolved.commit,
      status: "ready",
      statusMessage: null,
    }),
  ]);
}

async function publishGithubFailureState(status, statusMessage, lastError) {
  await Promise.all([
    updateSessionActivity({
      sourceStatus: status,
      sourceStatusMessage: statusMessage,
      lastError,
    }),
    updateWorkspaceSourceState({
      status,
      statusMessage,
    }),
  ]);
}

async function emptyWorkspaceDir(dir) {
  const entries = await fs.promises.readdir(dir, {withFileTypes: true}).catch((error) => {
    if (error && error.code === "ENOENT") return [];
    throw error;
  });
  await Promise.all(entries.map((entry) => (
    fs.promises.rm(path.join(dir, entry.name), {recursive: true, force: true})
  )));
}

async function syncDown() {
  if (!bucketName || !prefix) return;
  await syncWorktreeDown();
  await syncArchivesDown();
}

async function syncWorktreeDown() {
  if (!bucketName || !prefix) return;
  const [files] = await storage.bucket(bucketName).getFiles({prefix});
  await Promise.all(files.map(async (file) => {
    if (file.name.endsWith("/")) return;
    const relative = file.name.slice(prefix.length).replace(/^\//, "");
    if (!relative) return;
    if (shouldIgnoreWorkspacePath(relative)) return;
    if (relative.endsWith(`/${directoryMarkerFile}`)) {
      await fs.promises.mkdir(path.join(workspaceDir, path.dirname(relative)), {recursive: true});
      return;
    }
    const localPath = path.join(workspaceDir, relative);
    await fs.promises.mkdir(path.dirname(localPath), {recursive: true});
    await file.download({destination: localPath});
  }));
}

async function syncUp(options = {}) {
  if (!bucketName || !prefix) return;
  const {directories, files} = await walkWorkspace(workspaceDir);
  const desiredRemotePaths = new Set();

  await Promise.all(directories.map(async (localPath) => {
    const relative = normalizeRelativeWorkspacePath(path.relative(workspaceDir, localPath));
    if (!relative) return;
    const remotePath = workspaceRemotePath(`${relative}/${directoryMarkerFile}`);
    desiredRemotePaths.add(remotePath);
    await storage.bucket(bucketName).file(remotePath).save("", {
      contentType: "text/plain",
      resumable: false,
    });
  }));

  await Promise.all(files.map(async (localPath) => {
    const relative = normalizeRelativeWorkspacePath(path.relative(workspaceDir, localPath));
    const remotePath = workspaceRemotePath(relative);
    desiredRemotePaths.add(remotePath);
    await storage.bucket(bucketName).upload(localPath, {destination: remotePath});
  }));

  if (isGithubWorkspace()) {
    await reconcileGithubRemoteWorktree(desiredRemotePaths);
  }

  if (options.includeArchives) {
    await syncArchivesUp();
  }
}

async function reconcileGithubRemoteWorktree(desiredRemotePaths) {
  const [remoteFiles] = await storage.bucket(bucketName).getFiles({prefix: `${prefix}/`});
  await Promise.all(remoteFiles.map(async (file) => {
    if (!shouldManageGithubWorktreeRemotePath(file.name)) return;
    if (desiredRemotePaths.has(file.name)) return;
    await file.delete({ignoreNotFound: true});
  }));
}

function shouldManageGithubWorktreeRemotePath(remotePath) {
  if (!remotePath || remotePath.endsWith("/")) return false;
  const relative = normalizeRemoteWorkspacePath(remotePath);
  if (!relative) return false;
  if (relative === directoryMarkerFile) return false;
  if (relative === internalStorageDir || relative.startsWith(`${internalStorageDir}/`)) {
    return false;
  }
  return true;
}

function workspaceRemotePath(relativePath) {
  return `${prefix}/${normalizeRelativeWorkspacePath(relativePath)}`.replace(/\/+/g, "/");
}

function normalizeRemoteWorkspacePath(remotePath) {
  return normalizeRelativeWorkspacePath(String(remotePath || "").slice(prefix.length).replace(/^\/+/, ""));
}

async function walkWorkspace(dir) {
  const entries = await fs.promises.readdir(dir, {withFileTypes: true});
  const results = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    const relativePath = path.relative(workspaceDir, entryPath);
    if (shouldIgnoreWorkspacePath(relativePath)) return {directories: [], files: []};
    if (entry.isDirectory()) return walkWorkspace(entryPath);
    if (entry.isFile()) return {directories: [], files: [entryPath]};
    return {directories: [], files: []};
  }));
  return results.reduce((acc, result) => {
    acc.directories.push(...result.directories);
    acc.files.push(...result.files);
    return acc;
  }, {
    directories: dir === workspaceDir ? [] : [dir],
    files: [],
  });
}

async function syncArchivesDown(options = {}) {
  const excludeModes = new Set(options.excludeModes || []);
  await Promise.all(archiveSyncTargets.map(async (target) => {
    if (!target.restoreOnStartup || excludeModes.has(target.mode)) return;
    try {
      const file = storage.bucket(bucketName).file(target.remotePath);
      const [exists] = await file.exists();
      if (!exists) return;
      await fs.promises.mkdir(target.localPath, {recursive: true});
      await extractStorageArchive(file, target);
    } catch (error) {
      console.error(`archive restore failed for ${target.name}`, error);
      throw error;
    }
  }));
}

async function syncArchivesUp() {
  await Promise.all(archiveSyncTargets.map(async (target) => {
    try {
      if (!await pathExists(target.localPath)) return;
      const file = storage.bucket(bucketName).file(target.remotePath);
      if (target.mode === "workspaceNodeModules") {
        await uploadWorkspaceNodeModulesArchive(file, target);
        return;
      }
      if (target.mode === "workspaceGit") {
        await uploadWorkspaceGitArchive(file, target);
        return;
      }
      await uploadDirectoryArchive(file, target);
    } catch (error) {
      console.error(`archive upload failed for ${target.name}`, error);
      throw error;
    }
  }));
}

async function extractStorageArchive(file, target) {
  const tar = spawn("tar", ["-xzf", "-", "-C", target.localPath], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const stderr = collectStderr(tar);
  await Promise.all([
    pipeline(file.createReadStream(), tar.stdin),
    waitForChild(tar, stderr, `extract ${target.name}`),
  ]);
}

async function uploadDirectoryArchive(file, target) {
  const tar = spawn("tar", ["-czf", "-", "-C", target.localPath, "."], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = collectStderr(tar);
  await Promise.all([
    pipeline(tar.stdout, file.createWriteStream({
      resumable: true,
      metadata: {
        contentType: "application/gzip",
        metadata: {
          mapahceArchiveTarget: target.name,
        },
      },
    })),
    waitForChild(tar, stderr, `archive ${target.name}`),
  ]);
}

async function uploadWorkspaceNodeModulesArchive(file, target) {
  const nodeModulesDirs = await findNodeModulesDirs(workspaceDir);
  if (!nodeModulesDirs.length) return;
  await uploadTarEntries(file, target, nodeModulesDirs.map(toTarPath));
}

async function uploadWorkspaceGitArchive(file, target) {
  const gitEntries = await findGitArchiveEntries(target.localPath);
  if (!gitEntries.length) return;
  await uploadTarEntries(file, target, gitEntries.map(toTarPath));
}

async function uploadTarEntries(file, target, entries) {
  if (!entries.length) return;
  const tar = spawn("tar", ["--null", "-czf", "-", "-C", workspaceDir, "--files-from", "-"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  tar.stdin.end(Buffer.from(entries.join("\0") + "\0"));
  const stderr = collectStderr(tar);
  await Promise.all([
    pipeline(tar.stdout, file.createWriteStream({
      resumable: true,
      metadata: {
        contentType: "application/gzip",
        metadata: {
          mapahceArchiveTarget: target.name,
        },
      },
    })),
    waitForChild(tar, stderr, `archive ${target.name}`),
  ]);
}

async function findNodeModulesDirs(dir) {
  const entries = await fs.promises.readdir(dir, {withFileTypes: true});
  const results = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return [];
    const entryPath = path.join(dir, entry.name);
    const relativePath = path.relative(workspaceDir, entryPath);
    if (shouldIgnoreInternalWorkspacePath(relativePath)) return [];
    if (entry.name === "node_modules") return [entryPath];
    return findNodeModulesDirs(entryPath);
  }));
  return results.flat();
}

async function findGitArchiveEntries(dir) {
  const relativeDir = path.relative(workspaceDir, dir);
  if (!relativeDir || !await pathExists(dir)) return [];
  const entries = await fs.promises.readdir(dir, {withFileTypes: true});
  const results = [dir];
  for (const entry of entries) {
    if (entry.name.endsWith(".lock")) continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findGitArchiveEntries(entryPath));
      continue;
    }
    if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results;
}

function toTarPath(localPath) {
  return `./${path.relative(workspaceDir, localPath).split(path.sep).join("/")}`;
}

async function waitForChild(child, stderr, label) {
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`${label} failed with exit code ${code}: ${stderr()}`);
  }
}

function collectStderr(child) {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 4096) stderr = stderr.slice(stderr.length - 4096);
  });
  return () => stderr.trim();
}

async function runGitCommand(args, options = {}) {
  const child = spawn("git", args, {
    cwd: options.cwd || workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = collectStderr(child);
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > 8192) stdout = stdout.slice(stdout.length - 8192);
  });
  await waitForChild(child, stderr, `git ${args.join(" ")}`);
  return options.captureStdout ? stdout.trim() : "";
}

async function pathExists(localPath) {
  try {
    await fs.promises.access(localPath);
    return true;
  } catch (error) {
    return false;
  }
}

function shouldIgnoreWorkspacePath(relativePath) {
  const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.includes("node_modules") || parts[0] === internalStorageDir) {
    return true;
  }
  return workspaceSyncPolicyExclude.some((pattern) => matchesSyncPolicyPattern(normalizedPath, pattern));
}

function normalizeRelativeWorkspacePath(relativePath) {
  return String(relativePath || "").split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
}

function parseSyncPolicyExclude(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map((item) => normalizeEnvString(item)).filter(Boolean) : [];
  } catch (error) {
    console.error("invalid WORKSPACE_SYNC_POLICY_EXCLUDE, using no policy exclusions", error);
    return [];
  }
}

function matchesSyncPolicyPattern(relativePath, pattern) {
  const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
  const normalizedPattern = normalizeRelativeWorkspacePath(pattern);
  if (!normalizedPath || !normalizedPattern) return false;

  const pathParts = normalizedPath.split("/").filter(Boolean);
  const patternParts = normalizedPattern.split("/").filter(Boolean);
  if (!patternParts.length) return false;

  if (patternParts.length === 1) {
    return pathParts.includes(patternParts[0]);
  }

  for (let index = 0; index <= pathParts.length - patternParts.length; index++) {
    const window = pathParts.slice(index, index + patternParts.length);
    if (window.join("/") === patternParts.join("/")) {
      return true;
    }
  }
  return false;
}

function shouldIgnoreInternalWorkspacePath(relativePath) {
  const firstPart = String(relativePath || "").split(path.sep).filter(Boolean)[0] || "";
  return firstPart === internalStorageDir;
}

function archiveRemotePath(fileName) {
  if (!prefix) return "";
  return `${prefix}/${archiveStorageDir}/${fileName}`.replace(/\/+/g, "/");
}

async function appendHistory(stream, data) {
  if (!workspaceId || !sessionId) return;
  const body = String(data || "");
  if (!body) return;
  await db.collection("workspaces")
      .doc(workspaceId)
      .collection("sessions")
      .doc(sessionId)
      .collection("terminalHistory")
      .add({
        stream,
        data: body.slice(0, 4096),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch((error) => console.error("terminal history write failed", error));
}

async function updateSessionActivity(updates) {
  if (!workspaceId || !sessionId) return;
  await db.collection("workspaces")
      .doc(workspaceId)
      .collection("sessions")
      .doc(sessionId)
      .update(updates)
      .catch((error) => console.error("session activity write failed", error));
}

async function updateWorkspaceSourceState(updates) {
  if (!workspaceId) return;
  const workspaceUpdates = Object.entries(updates || {}).reduce((acc, [key, value]) => {
    acc[`source.${key}`] = value;
    return acc;
  }, {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("workspaces")
      .doc(workspaceId)
      .update(workspaceUpdates)
      .catch((error) => console.error("workspace source update failed", error));
}

function normalizePrefix(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function normalizeEnvString(value) {
  return String(value || "").trim();
}

function compactErrorMessage(value) {
  return normalizeEnvString(value).slice(0, 1000) || "unknown_error";
}

async function getGitStatusSummary() {
  const commit = await runGitCommand(["rev-parse", "HEAD"], {captureStdout: true});
  const branch = await runGitCommand(["branch", "--show-current"], {captureStdout: true});
  const porcelain = await runGitCommand(["status", "--porcelain=1", "--branch"], {captureStdout: true});
  const parsed = parseGitPorcelainStatus(porcelain);
  return {
    ok: true,
    git: true,
    sourceType: workspaceSourceMode,
    branch: branch || null,
    commit: commit || null,
    ahead: parsed.ahead,
    behind: parsed.behind,
    conflicted: parsed.conflicted > 0,
    dirty: {
      staged: parsed.staged,
      modified: parsed.modified,
      deleted: parsed.deleted,
      untracked: parsed.untracked,
      conflicted: parsed.conflicted,
    },
    files: parsed.files,
  };
}

async function stageGitPaths(payload) {
  const paths = normalizeGitActionPaths(payload.paths);
  await runGitCommand(["add", "--", ...paths]);
  return {
    ...(await getGitStatusSummary()),
    action: "stage",
    paths,
  };
}

async function unstageGitPaths(payload) {
  const paths = normalizeGitActionPaths(payload.paths);
  await runGitCommand(["reset", "HEAD", "--", ...paths]);
  return {
    ...(await getGitStatusSummary()),
    action: "unstage",
    paths,
  };
}

async function commitGitChanges(payload) {
  const message = normalizeGitCommitMessage(payload.message);
  const before = await getGitStatusSummary();
  if (!before.dirty || !before.dirty.staged) {
    throw new Error("empty_commit_not_allowed");
  }

  await runGitCommand(["commit", "-m", message]);
  const after = await getGitStatusSummary();
  return {
    ...after,
    action: "commit",
    commitMessage: message,
    committedHead: after.commit,
  };
}

async function pushGitChanges() {
  const branch = await runGitCommand(["branch", "--show-current"], {captureStdout: true});
  if (!branch) {
    throw new Error("git_push_no_current_branch");
  }

  let push = {ok: true, message: "", branch};
  try {
    await withGitPushAuth((env) => runGitCommand(["push", "origin", `HEAD:${branch}`], {env}));
  } catch (error) {
    if (String(error && error.message || "") === "github_auth_not_configured") {
      throw error;
    }
    push = {
      ok: false,
      message: compactErrorMessage(error && error.message ? error.message : error),
      branch,
    };
  }

  return {
    ...(await getGitStatusSummary()),
    action: "push",
    push,
  };
}

async function pullGitAction() {
  let pull = {ok: true, message: ""};
  await runGitCommand(["fetch", "--all", "--prune"]);
  try {
    await runGitCommand(["pull", "--no-rebase"]);
  } catch (error) {
    pull = {
      ok: false,
      message: compactErrorMessage(error && error.message ? error.message : error),
    };
  }

  return {
    ...(await getGitStatusSummary()),
    action: "pull",
    pull,
  };
}

function parseGitPorcelainStatus(output) {
  const lines = String(output || "").split(/\r?\n/).filter(Boolean);
  let ahead = null;
  let behind = null;
  let staged = 0;
  let modified = 0;
  let deleted = 0;
  let untracked = 0;
  let conflicted = 0;
  const files = [];
  const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const aheadMatch = line.match(/ahead (\d+)/);
      const behindMatch = line.match(/behind (\d+)/);
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      behind = behindMatch ? Number(behindMatch[1]) : 0;
      continue;
    }
    if (line.startsWith("??")) {
      untracked += 1;
      files.push({
        path: parseGitStatusPath(line.slice(3)),
        x: "?",
        y: "?",
        staged: false,
        unstaged: true,
        untracked: true,
        conflicted: false,
      });
      continue;
    }
    const x = line[0] || " ";
    const y = line[1] || " ";
    const code = `${x}${y}`;
    const file = {
      path: parseGitStatusPath(line.slice(3)),
      x,
      y,
      staged: x !== " ",
      unstaged: y !== " ",
      untracked: false,
      conflicted: conflictCodes.has(code),
    };
    files.push(file);
    if (file.conflicted) {
      conflicted += 1;
      continue;
    }
    if (x !== " ") staged += 1;
    if (y === "M" || y === "T") modified += 1;
    if (x === "D" || y === "D") deleted += 1;
  }

  return {ahead, behind, staged, modified, deleted, untracked, conflicted, files};
}

function parseGitStatusPath(value) {
  const text = String(value || "").trim();
  const renameParts = text.split(" -> ");
  return normalizeRelativeWorkspacePath(renameParts[renameParts.length - 1] || text);
}

function normalizeGitActionPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) {
    throw new Error("missing_paths");
  }
  return paths.map((item) => {
    const normalized = normalizeRelativeWorkspacePath(item);
    const parts = normalized.split("/").filter(Boolean);
    if (!parts.length || parts.some((part) => part === "." || part === "..")) {
      throw new Error("invalid_git_path");
    }
    if (parts[0] === internalStorageDir || parts.includes(directoryMarkerFile)) {
      throw new Error("invalid_git_path");
    }
    return normalized;
  });
}

function normalizeGitCommitMessage(value) {
  const message = normalizeEnvString(value);
  if (!message) {
    throw new Error("missing_commit_message");
  }
  return message.slice(0, 500);
}

async function withGitPushAuth(task) {
  const token = normalizeEnvString(process.env.GITHUB_PUSH_TOKEN);
  if (!token) {
    throw new Error("github_auth_not_configured");
  }

  const username = normalizeEnvString(process.env.GITHUB_PUSH_USERNAME) || "x-access-token";
  const askPassPath = path.join(process.env.TMPDIR || "/tmp", `mapahce-git-askpass-${sessionId || "runner"}.sh`);
  await fs.promises.writeFile(askPassPath, [
    "#!/bin/sh",
    "case \"$1\" in",
    "  *Username*) printf '%s\\n' \"${GITHUB_PUSH_USERNAME:-x-access-token}\" ;;",
    "  *) printf '%s\\n' \"${GITHUB_PUSH_TOKEN:-}\" ;;",
    "esac",
    "",
  ].join("\n"), {mode: 0o700});

  try {
    return await task({
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askPassPath,
      GITHUB_PUSH_USERNAME: username,
      GITHUB_PUSH_TOKEN: token,
    });
  } finally {
    await fs.promises.rm(askPassPath, {force: true}).catch(() => {});
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value || fallback);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function terminalCommand() {
  const command = String(process.env.TERMINAL_COMMAND || "").trim();
  if (command) {
    const args = terminalArgs();
    return {file: command, args, display: [command, ...args].join(" ")};
  }

  const shell = process.env.SHELL || "bash";
  return {file: shell, args: ["-l"], display: `${shell} -l`};
}

function terminalArgs() {
  try {
    const value = JSON.parse(process.env.TERMINAL_ARGS || "[]");
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch (error) {
    console.error("invalid TERMINAL_ARGS, using no arguments", error);
    return [];
  }
}

function renderTerminalPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Cloud Terminal</title>
    <link rel="stylesheet" href="/xterm/css/xterm.css">
    <style>
      html, body {
        height: 100%;
        margin: 0;
        background: #0d1117;
      }
      #terminal {
        height: 100%;
        width: 100%;
        box-sizing: border-box;
        padding: 10px;
      }
    </style>
  </head>
  <body>
    <div id="terminal"></div>
    <script src="/xterm/lib/xterm.js"></script>
    <script>
      const terminalElement = document.getElementById("terminal");
      const term = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 14,
        lineHeight: 1.45,
        scrollback: 5000,
        theme: {
          background: "#0d1117",
          foreground: "#d6deeb",
          cursor: "#d6deeb",
          selectionBackground: "#334155",
        },
      });
      let socket = null;
      let reconnectTimer = null;
      let replayOnConnect = true;
      let terminalExited = false;

      term.open(terminalElement);
      term.focus();

      term.onData((data) => {
        sendData(data);
      });

      term.onResize(({cols, rows}) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({type: "resize", cols, rows}));
        }
      });

      terminalElement.addEventListener("pointerdown", () => term.focus());
      window.addEventListener("resize", resizeTerminal);

      function resizeTerminal() {
        const rect = terminalElement.getBoundingClientRect();
        const cols = Math.max(40, Math.floor((rect.width - 20) / 8.5));
        const rows = Math.max(12, Math.floor((rect.height - 20) / 20.3));
        term.resize(cols, rows);
      }

      function sendData(data) {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({type: "data", data}));
        }
      }

      function connectTerminal() {
        const protocol = location.protocol === "https:" ? "wss://" : "ws://";
        const replay = replayOnConnect ? "1" : "0";
        socket = new WebSocket(protocol + location.host + "/terminal?replay=" + replay);
        replayOnConnect = false;

        socket.addEventListener("open", () => {
          resizeTerminal();
        });

        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "data") term.write(message.data);
          if (message.type === "exit") {
            terminalExited = true;
            term.write("\\r\\n[process exited with code " + message.exitCode + "]\\r\\n");
          }
        });

        socket.addEventListener("close", () => {
          if (terminalExited || reconnectTimer) return;
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connectTerminal();
          }, 1000);
        });
      }

      resizeTerminal();
      connectTerminal();
    </script>
  </body>
</html>`;
}
