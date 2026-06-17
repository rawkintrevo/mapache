"use strict";

const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");
const {pipeline} = require("stream/promises");
const {collectStderr, waitForChild} = require("./processes");
const {
  compactErrorMessage,
  matchesSyncPolicyPattern,
  normalizeRelativeWorkspacePath,
  pathExists,
} = require("./utils");

function createWorkspaceService({admin, config, db, git, storage}) {
  const archiveSyncTargets = createArchiveSyncTargets();

  async function ensureWorkspace() {
    await fs.promises.mkdir(config.workspaceDir, {recursive: true});
    await Promise.all(archiveSyncTargets
        .filter((target) => target.ensureLocalPath)
        .map((target) => fs.promises.mkdir(target.localPath, {recursive: true})));
  }

  async function prepareWorkspaceSource() {
    if (git.isBlankWorkspace()) {
      await syncDown();
      return;
    }

    await emptyWorkspaceDir(config.workspaceDir);

    let restoredGitArchive = false;
    try {
      restoredGitArchive = await restoreGithubGitArchiveIfPresent();
      if (!restoredGitArchive) {
        await git.cloneGithubWorkspace();
      }
    } catch (error) {
      const handler = restoredGitArchive ? git.recordGithubSyncFailure : git.recordGithubCloneFailure;
      await handler(error);
      const label = restoredGitArchive ?
        "GitHub workspace cache restore failed" :
        "GitHub workspace startup failed";
      throw new Error(`${label}: ${compactErrorMessage(error.message || error)}`);
    }

    try {
      await syncWorktreeDown();
      await syncArchivesDown({excludeModes: ["workspaceGit"]});
      const resolved = await git.resolveGitHead();
      console.log(`github workspace ready at ${resolved.commit}${resolved.branch ? ` on ${resolved.branch}` : ""}`);
      await git.publishGithubResolvedMetadata(resolved);
    } catch (error) {
      await git.recordGithubSyncFailure(error);
      throw new Error(`GitHub workspace cache restore failed: ${compactErrorMessage(error.message || error)}`);
    }
  }

  async function restoreGithubGitArchiveIfPresent() {
    const target = archiveSyncTargets.find((item) => item.mode === "workspaceGit");
    if (!target || !config.bucketName || !config.prefix) return false;

    const file = storage.bucket(config.bucketName).file(target.remotePath);
    const [exists] = await file.exists();
    if (!exists) {
      console.log("no cached .git archive found; falling back to clone");
      return false;
    }

    console.log("restoring cached .git archive");
    try {
      await fs.promises.mkdir(target.localPath, {recursive: true});
      await extractStorageArchive(file, target);
      if (await hasValidGithubGitArchiveRestore()) {
        return true;
      }
      console.warn("cached .git archive did not restore a valid repository; falling back to clone");
      await fs.promises.rm(target.localPath, {recursive: true, force: true});
      return false;
    } catch (error) {
      throw new Error(`git archive restore failed: ${compactErrorMessage(error.message || error)}`);
    }
  }

  async function hasValidGithubGitArchiveRestore() {
    try {
      const gitDir = await git.runGitCommand(["rev-parse", "--git-dir"], {captureStdout: true});
      const head = await git.runGitCommand(["rev-parse", "--verify", "HEAD"], {captureStdout: true});
      return Boolean(gitDir && head);
    } catch {
      return false;
    }
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
    if (!config.bucketName || !config.prefix) return;
    await syncWorktreeDown();
    await syncArchivesDown();
  }

  async function syncWorktreeDown() {
    if (!config.bucketName || !config.prefix) return;
    const [files] = await storage.bucket(config.bucketName).getFiles({prefix: config.prefix});
    await Promise.all(files.map(async (file) => {
      if (file.name.endsWith("/")) return;
      const relative = file.name.slice(config.prefix.length).replace(/^\//, "");
      if (!relative) return;
      if (shouldIgnoreWorkspacePath(relative)) return;
      if (relative.endsWith(`/${config.directoryMarkerFile}`)) {
        await fs.promises.mkdir(path.join(config.workspaceDir, path.dirname(relative)), {recursive: true});
        return;
      }
      const localPath = path.join(config.workspaceDir, relative);
      await fs.promises.mkdir(path.dirname(localPath), {recursive: true});
      await file.download({destination: localPath});
    }));
  }

  async function syncUp(options = {}) {
    await synchronizePiAuth({materialize: true});
    if (!config.bucketName || !config.prefix) return;
    const {directories, files} = await walkWorkspace(config.workspaceDir);
    const desiredRemotePaths = new Set();

    await Promise.all(directories.map(async (localPath) => {
      const relative = normalizeRelativeWorkspacePath(path.relative(config.workspaceDir, localPath));
      if (!relative) return;
      const remotePath = workspaceRemotePath(`${relative}/${config.directoryMarkerFile}`);
      desiredRemotePaths.add(remotePath);
      await storage.bucket(config.bucketName).file(remotePath).save("", {
        contentType: "text/plain",
        resumable: false,
      });
    }));

    await Promise.all(files.map(async (localPath) => {
      const relative = normalizeRelativeWorkspacePath(path.relative(config.workspaceDir, localPath));
      const remotePath = workspaceRemotePath(relative);
      desiredRemotePaths.add(remotePath);
      await syncFileUpPreservingNewerRemote(localPath, remotePath);
    }));

    if (git.isGithubWorkspace()) {
      await reconcileGithubRemoteWorktree(desiredRemotePaths);
    }

    if (options.includeArchives) {
      await syncArchivesUp();
    }
  }

  async function reconcileGithubRemoteWorktree(desiredRemotePaths) {
    const [remoteFiles] = await storage.bucket(config.bucketName).getFiles({prefix: `${config.prefix}/`});
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
    if (relative === config.directoryMarkerFile) return false;
    if (relative === config.internalStorageDir || relative.startsWith(`${config.internalStorageDir}/`)) {
      return false;
    }
    return true;
  }

  function workspaceRemotePath(relativePath) {
    return `${config.prefix}/${normalizeRelativeWorkspacePath(relativePath)}`.replace(/\/+/g, "/");
  }

  async function syncFileUpPreservingNewerRemote(localPath, remotePath) {
    const file = storage.bucket(config.bucketName).file(remotePath);
    if (await remoteObjectNewerThanLocal(file, localPath)) {
      await fs.promises.mkdir(path.dirname(localPath), {recursive: true});
      await file.download({destination: localPath});
      return;
    }
    await storage.bucket(config.bucketName).upload(localPath, {destination: remotePath});
  }

  async function remoteObjectNewerThanLocal(file, localPath) {
    try {
      const [metadata] = await file.getMetadata();
      const localStat = await fs.promises.stat(localPath);
      const remoteUpdatedMs = Date.parse(metadata.updated || metadata.timeCreated || "");
      if (!Number.isFinite(remoteUpdatedMs)) return false;
      return remoteUpdatedMs > localStat.mtimeMs + 1000;
    } catch (error) {
      if (error && (error.code === 404 || error.code === "ENOENT")) return false;
      throw error;
    }
  }

  function normalizeRemoteWorkspacePath(remotePath) {
    return normalizeRelativeWorkspacePath(String(remotePath || "").slice(config.prefix.length).replace(/^\/+/, ""));
  }

  async function walkWorkspace(dir) {
    const entries = await fs.promises.readdir(dir, {withFileTypes: true});
    const results = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      const relativePath = path.relative(config.workspaceDir, entryPath);
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
      directories: dir === config.workspaceDir ? [] : [dir],
      files: [],
    });
  }

  async function syncArchivesDown(options = {}) {
    const excludeModes = new Set(options.excludeModes || []);
    await Promise.all(archiveSyncTargets.map(async (target) => {
      if (!target.restoreOnStartup || excludeModes.has(target.mode)) return;
      try {
        const file = await findArchiveFile(target);
        if (!file) return;
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
        const file = archiveFile(target);
        if (!file) return;
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

  async function synchronizePiAuth(options = {}) {
    if (!config.ownerUid) return;
    const ref = db.collection("users").doc(config.ownerUid).collection("private").doc("piAuth");
    const localAuth = await readPiAuthFile();

    if (Object.keys(localAuth).length) {
      await ref.set({
        providers: localAuth,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
    }

    if (!options.materialize) return;

    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const selection = await readSessionPiAuthSelection();
    const remoteAuth = buildMaterializedPiAuth(data, selection);
    if (!Object.keys(remoteAuth).length && !Object.keys(localAuth).length) return;

    const mergedAuth = selection ? remoteAuth : {
      ...localAuth,
      ...remoteAuth,
    };
    await writePiAuthFile(mergedAuth);
    console.log(`pi auth materialized ${Object.keys(mergedAuth).length} provider(s) to ${piAuthFilePath()}`);
  }

  async function readSessionPiAuthSelection() {
    if (!config.workspaceId || !config.sessionId) return null;
    try {
      const snap = await db.collection("workspaces").doc(config.workspaceId).collection("sessions").doc(config.sessionId).get();
      const data = snap.exists ? snap.data() : {};
      if (!Object.prototype.hasOwnProperty.call(data, "piAuthSelection")) return null;
      return normalizePiAuthSelection(data.piAuthSelection);
    } catch (error) {
      console.warn("pi auth selection read failed", compactErrorMessage(error.message || error));
      return null;
    }
  }

  async function materializePiAuthNow(selection = null) {
    const ref = db.collection("users").doc(config.ownerUid).collection("private").doc("piAuth");
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const auth = buildMaterializedPiAuth(data, selection === null ? await readSessionPiAuthSelection() : selection);
    await writePiAuthFile(auth);
    console.log(`pi auth materialized ${Object.keys(auth).length} selected provider(s) to ${piAuthFilePath()}`);
    return {ok: true, appliedToRunner: true, providerCount: Object.keys(auth).length};
  }

  function buildMaterializedPiAuth(data, selection) {
    const providers = normalizePiAuthProviders(data && data.providers);
    const entries = normalizePiAuthEntries(data && data.entries, providers);
    if (selection && typeof selection === "object") {
      const normalizedSelection = normalizePiAuthSelection(selection, entries);
      return Object.entries(normalizedSelection).reduce((acc, [providerKey, entryId]) => {
        const entry = entries[entryId];
        if (entry && entry.providerKey === providerKey) acc[providerKey] = entry.credential;
        return acc;
      }, {});
    }
    return providers;
  }

  async function readPiAuthFile() {
    const authPath = piAuthFilePath();
    try {
      const content = await fs.promises.readFile(authPath, "utf8");
      return normalizePiAuthProviders(JSON.parse(content));
    } catch (error) {
      if (error && error.code === "ENOENT") return {};
      console.warn("pi auth read failed", compactErrorMessage(error.message || error));
      return {};
    }
  }

  async function writePiAuthFile(auth) {
    const authPath = piAuthFilePath();
    await fs.promises.mkdir(path.dirname(authPath), {recursive: true});
    await fs.promises.writeFile(authPath, `${JSON.stringify(normalizePiAuthProviders(auth), null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.promises.chmod(authPath, 0o600).catch(() => {});
  }

  function piAuthFilePath() {
    return path.join(process.env.PI_HOME_DIR || "/root/.pi", "agent", "auth.json");
  }

  function normalizePiAuthProviders(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.entries(value).reduce((acc, [provider, credential]) => {
      const key = normalizeAuthKey(provider);
      if (!key || !credential || typeof credential !== "object" || Array.isArray(credential)) return acc;
      acc[key] = normalizePlainAuthObject(credential);
      return acc;
    }, {});
  }

  function normalizePiAuthEntries(value, providers = {}) {
    const entries = value && typeof value === "object" && !Array.isArray(value) ?
      Object.entries(value).reduce((acc, [id, entry]) => {
        const normalizedId = normalizePiAuthEntryId(id || entry && entry.id);
        if (!normalizedId || !entry || typeof entry !== "object" || Array.isArray(entry)) return acc;
        const providerKey = normalizeAuthKey(entry.providerKey || entry.provider || "");
        const credential = normalizePlainAuthObject(entry.credential || entry.value || {});
        if (!providerKey || !Object.keys(credential).length) return acc;
        acc[normalizedId] = {
          id: normalizedId,
          providerKey,
          label: normalizeAuthKey(entry.label || "") || providerKey,
          credential,
          createdAt: normalizeAuthKey(entry.createdAt || ""),
        };
        return acc;
      }, {}) :
      {};

    Object.entries(providers || {}).forEach(([providerKey, credential]) => {
      const hasProviderEntry = Object.values(entries).some((entry) => entry.providerKey === providerKey);
      if (!hasProviderEntry) {
        const id = `legacy-${providerKey}`;
        entries[id] = {
          id,
          providerKey,
          label: providerKey,
          credential: normalizePlainAuthObject(credential),
          createdAt: "",
        };
      }
    });
    return entries;
  }

  function normalizePiAuthSelection(value, entries = null) {
    const selected = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return Object.entries(selected).reduce((acc, [provider, entryId]) => {
      const providerKey = normalizeAuthKey(provider);
      const normalizedEntryId = normalizePiAuthEntryId(entryId);
      if (!providerKey || !normalizedEntryId) return acc;
      if (entries) {
        const entry = entries[normalizedEntryId];
        if (entry && entry.providerKey === providerKey) acc[providerKey] = normalizedEntryId;
        return acc;
      }
      acc[providerKey] = normalizedEntryId;
      return acc;
    }, {});
  }

  function normalizePiAuthEntryId(value) {
    const id = normalizeAuthKey(value);
    if (!id || id.length > 256 || /[^a-zA-Z0-9_.:-]/.test(id)) return "";
    return id;
  }

  function normalizePlainAuthObject(value) {
    return Object.entries(value || {}).reduce((acc, [key, item]) => {
      const cleanKey = normalizeAuthKey(key);
      if (!cleanKey) return acc;
      const normalized = normalizePlainAuthValue(item);
      if (normalized !== undefined) acc[cleanKey] = normalized;
      return acc;
    }, {});
  }

  function normalizePlainAuthValue(value) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
    if (Array.isArray(value)) {
      return value.map(normalizePlainAuthValue).filter((entry) => entry !== undefined);
    }
    if (value && typeof value === "object") return normalizePlainAuthObject(value);
    return undefined;
  }

  function normalizeAuthKey(value) {
    return String(value || "").trim().slice(0, 256);
  }

  async function findArchiveFile(target) {
    const archives = [
      {bucketName: target.bucketName || config.bucketName, remotePath: target.remotePath},
      ...(target.fallbackArchives || []),
    ];
    for (const archive of archives) {
      const file = archiveFile({
        bucketName: archive.bucketName,
        remotePath: archive.remotePath,
      });
      if (!file) continue;
      const [exists] = await file.exists();
      if (exists) return file;
    }
    return null;
  }

  function archiveFile(target, remotePath = target.remotePath) {
    const targetBucketName = target.bucketName || config.bucketName;
    if (!targetBucketName || !remotePath) return null;
    return storage.bucket(targetBucketName).file(remotePath);
  }

  async function extractStorageArchive(file, target) {
    const tar = spawn("tar", [...tarExcludeArgs(target), "-xzf", "-", "-C", target.localPath], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stderr = collectStderr(tar);
    await Promise.all([
      pipeline(file.createReadStream(), tar.stdin),
      waitForChild(tar, stderr, `extract ${target.name}`),
    ]);
  }

  async function uploadDirectoryArchive(file, target) {
    const tar = spawn("tar", [...tarExcludeArgs(target), "-czf", "-", "-C", target.localPath, "."], {
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
    const nodeModulesDirs = await findNodeModulesDirs(config.workspaceDir);
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
    const tar = spawn("tar", ["--null", "-czf", "-", "-C", config.workspaceDir, "--files-from", "-"], {
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
      const relativePath = path.relative(config.workspaceDir, entryPath);
      if (shouldIgnoreInternalWorkspacePath(relativePath)) return [];
      if (entry.name === "node_modules") return [entryPath];
      return findNodeModulesDirs(entryPath);
    }));
    return results.flat();
  }

  async function findGitArchiveEntries(dir) {
    const relativeDir = path.relative(config.workspaceDir, dir);
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
    return `./${path.relative(config.workspaceDir, localPath).split(path.sep).join("/")}`;
  }

  function shouldIgnoreWorkspacePath(relativePath) {
    const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
    const parts = normalizedPath.split("/").filter(Boolean);
    if (parts.includes("node_modules") || parts[0] === config.internalStorageDir || isWorkspacePiPackageCachePath(parts)) {
      return true;
    }
    return config.workspaceSyncPolicyExclude.some((pattern) => matchesSyncPolicyPattern(normalizedPath, pattern));
  }

  function isWorkspacePiPackageCachePath(parts) {
    return parts[0] === ".pi" && (parts[1] === "npm" || parts[1] === "git");
  }

  function shouldIgnoreInternalWorkspacePath(relativePath) {
    const firstPart = String(relativePath || "").split(path.sep).filter(Boolean)[0] || "";
    return firstPart === config.internalStorageDir;
  }

  function archiveRemotePath(fileName) {
    if (!config.prefix) return "";
    return `${config.prefix}/${config.archiveStorageDir}/${fileName}`.replace(/\/+/g, "/");
  }

  function piHomeArchiveRemotePath(fileName) {
    if (!config.piHomePrefix) return archiveRemotePath(fileName);
    return `${config.piHomePrefix}/${fileName}`.replace(/\/+/g, "/");
  }

  function piSessionArchiveRemotePath(fileName) {
    if (!config.piSessionStoragePrefix) return "";
    return `${config.piSessionStoragePrefix}/${fileName}`.replace(/\/+/g, "/");
  }

  function tarExcludeArgs(target) {
    return (target.exclude || []).map((pattern) => `--exclude=${pattern}`);
  }

  function piHomeArchiveExcludes() {
    return [
      "agent/sessions",
      "agent/sessions/*",
      "./agent/sessions",
      "./agent/sessions/*",
      "agent/mapache-sessions",
      "agent/mapache-sessions/*",
      "./agent/mapache-sessions",
      "./agent/mapache-sessions/*",
    ];
  }

  function createArchiveSyncTargets() {
    const targets = [
      {
        name: "workspace-node-modules",
        mode: "workspaceNodeModules",
        localPath: config.workspaceDir,
        remotePath: archiveRemotePath("workspace-node_modules.tar.gz"),
        ensureLocalPath: true,
        restoreOnStartup: true,
      },
      {
        name: "workspace-pi-npm",
        mode: "directory",
        localPath: path.join(config.workspaceDir, ".pi", "npm"),
        remotePath: archiveRemotePath("workspace-pi-npm.tar.gz"),
        ensureLocalPath: false,
        restoreOnStartup: true,
      },
      {
        name: "workspace-pi-git",
        mode: "directory",
        localPath: path.join(config.workspaceDir, ".pi", "git"),
        remotePath: archiveRemotePath("workspace-pi-git.tar.gz"),
        ensureLocalPath: false,
        restoreOnStartup: true,
      },
      {
        name: "root-pi",
        mode: "directory",
        localPath: process.env.PI_HOME_DIR || "/root/.pi",
        bucketName: config.piHomeBucketName,
        remotePath: piHomeArchiveRemotePath("root-pi.tar.gz"),
        fallbackArchives: [{
          bucketName: config.bucketName,
          remotePath: archiveRemotePath("root-pi.tar.gz"),
        }],
        exclude: piHomeArchiveExcludes(),
        ensureLocalPath: true,
        restoreOnStartup: true,
      },
      {
        name: "pi-session",
        mode: "directory",
        localPath: config.piSessionDir,
        bucketName: config.piSessionStorageBucket,
        remotePath: piSessionArchiveRemotePath("pi-session.tar.gz"),
        ensureLocalPath: true,
        restoreOnStartup: true,
      },
    ];

    if (git.isGithubWorkspace()) {
      targets.push({
        name: "workspace-git",
        mode: "workspaceGit",
        localPath: path.join(config.workspaceDir, ".git"),
        remotePath: archiveRemotePath("workspace-git.tar.gz"),
        ensureLocalPath: false,
        restoreOnStartup: true,
      });
    }

    return targets;
  }

  return {
    archiveSyncTargets,
    ensureWorkspace,
    prepareWorkspaceSource,
    syncArchivesDown,
    syncArchivesUp,
    syncDown,
    syncUp,
    synchronizePiAuth,
    materializePiAuthNow,
  };
}

module.exports = {
  createWorkspaceService,
};
