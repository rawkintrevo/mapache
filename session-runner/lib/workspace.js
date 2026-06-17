"use strict";

const fs = require("fs");
const path = require("path");
const {createWorkspaceArchiveService} = require("./workspaceArchives.service");
const {createGithubWorkspaceRestoreService} = require("./workspaceGithub.service");
const {createWorkspacePathHelpers} = require("./workspacePath.helpers");
const {createWorkspacePiAuthService} = require("./workspacePiAuth.service");
const {normalizeRelativeWorkspacePath} = require("./utils");

function createWorkspaceService({admin, config, db, git, storage}) {
  const pathHelpers = createWorkspacePathHelpers({config});
  const archives = createWorkspaceArchiveService({config, git, pathHelpers, storage});
  const piAuth = createWorkspacePiAuthService({admin, config, db});
  const githubRestore = createGithubWorkspaceRestoreService({
    archives,
    config,
    git,
    syncWorktreeDown,
  });

  async function ensureWorkspace() {
    await fs.promises.mkdir(config.workspaceDir, {recursive: true});
    await Promise.all(archives.archiveSyncTargets
        .filter((target) => target.ensureLocalPath)
        .map((target) => fs.promises.mkdir(target.localPath, {recursive: true})));
  }

  async function prepareWorkspaceSource() {
    if (git.isBlankWorkspace()) {
      await syncDown();
      return;
    }

    await githubRestore.prepareWorkspaceSource();
  }

  async function syncDown() {
    if (!config.bucketName || !config.prefix) return;
    await syncWorktreeDown();
    await archives.syncArchivesDown();
  }

  async function syncWorktreeDown() {
    if (!config.bucketName || !config.prefix) return;
    const [files] = await storage.bucket(config.bucketName).getFiles({prefix: config.prefix});
    await Promise.all(files.map(async (file) => {
      if (file.name.endsWith("/")) return;
      const relative = file.name.slice(config.prefix.length).replace(/^\//, "");
      if (!relative) return;
      if (pathHelpers.shouldIgnoreWorkspacePath(relative)) return;
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
    await piAuth.synchronizePiAuth({materialize: true});
    if (!config.bucketName || !config.prefix) return;
    const {directories, files} = await walkWorkspace(config.workspaceDir);
    const desiredRemotePaths = new Set();

    await Promise.all(directories.map(async (localPath) => {
      const relative = normalizeRelativeWorkspacePath(path.relative(config.workspaceDir, localPath));
      if (!relative) return;
      const remotePath = pathHelpers.workspaceRemotePath(`${relative}/${config.directoryMarkerFile}`);
      desiredRemotePaths.add(remotePath);
      await storage.bucket(config.bucketName).file(remotePath).save("", {
        contentType: "text/plain",
        resumable: false,
      });
    }));

    await Promise.all(files.map(async (localPath) => {
      const relative = normalizeRelativeWorkspacePath(path.relative(config.workspaceDir, localPath));
      const remotePath = pathHelpers.workspaceRemotePath(relative);
      desiredRemotePaths.add(remotePath);
      await syncFileUpPreservingNewerRemote(localPath, remotePath);
    }));

    if (git.isGithubWorkspace()) {
      await reconcileGithubRemoteWorktree(desiredRemotePaths);
    }

    if (options.includeArchives) {
      await archives.syncArchivesUp();
    }
  }

  async function reconcileGithubRemoteWorktree(desiredRemotePaths) {
    const [remoteFiles] = await storage.bucket(config.bucketName).getFiles({prefix: `${config.prefix}/`});
    await Promise.all(remoteFiles.map(async (file) => {
      if (!pathHelpers.shouldManageGithubWorktreeRemotePath(file.name)) return;
      if (desiredRemotePaths.has(file.name)) return;
      await file.delete({ignoreNotFound: true});
    }));
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

  async function walkWorkspace(dir) {
    const entries = await fs.promises.readdir(dir, {withFileTypes: true});
    const results = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      const relativePath = path.relative(config.workspaceDir, entryPath);
      if (pathHelpers.shouldIgnoreWorkspacePath(relativePath)) return {directories: [], files: []};
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

  return {
    archiveSyncTargets: archives.archiveSyncTargets,
    ensureWorkspace,
    materializePiAuthNow: piAuth.materializePiAuthNow,
    prepareWorkspaceSource,
    syncArchivesDown: archives.syncArchivesDown,
    syncArchivesUp: archives.syncArchivesUp,
    syncDown,
    syncUp,
    synchronizePiAuth: piAuth.synchronizePiAuth,
  };
}

module.exports = {
  createWorkspaceService,
};
