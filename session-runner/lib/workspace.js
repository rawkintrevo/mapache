"use strict";

const fs = require("fs");
const path = require("path");
const {createWorkspaceArchiveService} = require("./workspaceArchives.service");
const {createGithubWorkspaceRestoreService} = require("./workspaceGithub.service");
const {createWorkspacePathHelpers} = require("./workspacePath.helpers");
const {createWorkspaceAuthService} = require("./workspaceAuth.service");
const {generationMatchOptions, isStorageGenerationConflict} = require("./workspaceSyncGeneration.helpers");
const {normalizeRelativeWorkspacePath} = require("./utils");
const {assertSharedWorkspaceMount, isMountedWorkspaceMode} = require("./sharedWorkspace.helpers");

const {assertAutomationStorageMounts} = require("./automationStorage.helpers");

function createWorkspaceService({admin, checkpointIdentity, checkpointPublisher, checkpointRestore, config, db, git, storage}) {
  const pathHelpers = createWorkspacePathHelpers({config});
  const archives = createWorkspaceArchiveService({config, git, pathHelpers, storage});
  const auth = createWorkspaceAuthService({admin, config, db});
  const githubRestore = createGithubWorkspaceRestoreService({
    archives,
    config,
    git,
    syncWorktreeDown,
  });

  async function ensureWorkspace() {
    if (isMountedWorkspaceMode(config.workspaceStorageMode)) {
      await assertSharedWorkspaceMount(config);
      await assertAutomationStorageMounts(config);
    } else {
      await fs.promises.mkdir(config.workspaceDir, {recursive: true});
    }
    await fs.promises.mkdir(config.piSessionDir, {recursive: true});
    if (!isMountedWorkspaceMode(config.workspaceStorageMode)) {
      await Promise.all(archives.archiveSyncTargets
          .filter((target) => target.ensureLocalPath)
          .map((target) => fs.promises.mkdir(target.localPath, {recursive: true})));
    }
  }

  async function prepareWorkspaceSource() {
    if (isMountedWorkspaceMode(config.workspaceStorageMode)) {
      await assertSharedWorkspaceMount(config);
      return {ok: true, skipped: true, reason: "shared_gcsfuse_authoritative"};
    }
    if (git.isBlankWorkspace()) {
      await syncDown();
      return;
    }

    await githubRestore.prepareWorkspaceSource();
  }

  async function syncDown() {
    if (isMountedWorkspaceMode(config.workspaceStorageMode)) {
      return {ok: true, skipped: true, reason: "shared_gcsfuse_authoritative"};
    }
    if (!config.bucketName || !config.prefix) return;
    await syncWorktreeDown();
    await archives.syncArchivesDown();
  }

  async function syncWorktreeDown() {
    if (isMountedWorkspaceMode(config.workspaceStorageMode)) return;
    if (!config.bucketName || !config.prefix) return;
    // Marked runtimes use the immutable workspace-file manifest. The legacy
    // flat prefix must not repopulate state when a checkpoint is absent.
    if (config.agentRuntimeEnabled) return;
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

  async function restoreCheckpoint() {
    if (!config.agentRuntimeEnabled || !checkpointRestore?.restoreCheckpoint) {
      return {ok: true, skipped: true};
    }
    const result = await checkpointRestore.restoreCheckpoint({
      shouldIgnore: pathHelpers.shouldIgnoreWorkspacePath,
    });
    return result;
  }

  async function syncUp(options = {}) {
    await options.assertCurrentWriter?.();
    await auth.synchronizeAuth({materialize: true});
    if (isMountedWorkspaceMode(config.workspaceStorageMode)) {
      await git.archiveSharedWorkspaceGit?.();
      return {conflicts: [], skipped: true, reason: "shared_gcsfuse_authoritative"};
    }
    if (!config.bucketName || !config.prefix) return {conflicts: []};
    if (config.agentRuntimeEnabled && checkpointPublisher?.publishWorkspaceFiles) {
      const identity = {
        ...(typeof checkpointIdentity === "function" ? checkpointIdentity() : {}),
        generation: config.agentRuntimeGeneration,
        sessionId: config.sessionId,
        workspaceId: config.workspaceId,
      };
      try {
        const publication = await checkpointPublisher.publishWorkspaceFiles({
          ...identity,
          assertCurrentWriter: options.assertCurrentWriter,
          shouldIgnore: pathHelpers.shouldIgnoreWorkspacePath,
          sourceRoot: config.workspaceDir,
        });
        return {conflicts: [], ...publication};
      } catch (error) {
        try {
          await checkpointPublisher.recordCheckpointError?.(error.code || "checkpoint_workspace_publish_failed", identity);
        } catch (_statusError) {
          // Preserve the publication failure; status persistence is best effort.
        }
        throw error;
      }
    }
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

    const uploadResults = await Promise.all(files.map(async (localPath) => {
      const relative = normalizeRelativeWorkspacePath(path.relative(config.workspaceDir, localPath));
      const remotePath = pathHelpers.workspaceRemotePath(relative);
      desiredRemotePaths.add(remotePath);
      return syncFileUpPreservingNewerRemote(localPath, remotePath);
    }));

    await options.assertCurrentWriter?.();
    const reconcileConflicts = await reconcileManagedRemoteWorktree(desiredRemotePaths);

    if (options.includeArchives) {
      await options.assertCurrentWriter?.();
      await archives.syncArchivesUp();
    }
    return {
      conflicts: [
        ...uploadResults.filter((result) => result?.status === "conflict"),
        ...reconcileConflicts,
      ],
    };
  }

  async function reconcileManagedRemoteWorktree(desiredRemotePaths) {
    if (!git.isGithubWorkspace() && !git.isBlankWorkspace()) return [];
    const [remoteFiles] = await storage.bucket(config.bucketName).getFiles({prefix: `${config.prefix}/`});
    const results = await Promise.all(remoteFiles.map(async (file) => {
      if (!pathHelpers.shouldManageWorkspaceRemotePath(file.name)) return null;
      if (desiredRemotePaths.has(file.name)) return null;
      let metadata;
      try {
        [metadata] = await file.getMetadata();
      } catch (error) {
        if (error && (error.code === 404 || error.code === "ENOENT")) return null;
        throw error;
      }
      try {
        await file.delete({ignoreNotFound: true, ifGenerationMatch: metadata.generation});
        return null;
      } catch (error) {
        if (isStorageGenerationConflict(error)) return {status: "conflict", path: file.name};
        throw error;
      }
    }));
    return results.filter(Boolean);
  }

  async function syncFileUpPreservingNewerRemote(localPath, remotePath) {
    const file = storage.bucket(config.bucketName).file(remotePath);
    let metadata = null;
    try {
      [metadata] = await file.getMetadata();
    } catch (error) {
      if (!(error && (error.code === 404 || error.code === "ENOENT"))) throw error;
    }
    if (metadata && await remoteObjectNewerThanLocal(metadata, localPath)) {
      await fs.promises.mkdir(path.dirname(localPath), {recursive: true});
      await file.download({destination: localPath});
      return {status: "remote_newer", path: remotePath};
    }
    try {
      await storage.bucket(config.bucketName).upload(localPath, {
        destination: remotePath,
        ...generationMatchOptions(metadata?.generation),
      });
      return {status: "uploaded", path: remotePath};
    } catch (error) {
      if (isStorageGenerationConflict(error)) return {status: "conflict", path: remotePath};
      throw error;
    }
  }

  async function remoteObjectNewerThanLocal(metadata, localPath) {
    const localStat = await fs.promises.stat(localPath);
    const remoteUpdatedMs = Date.parse(metadata.updated || metadata.timeCreated || "");
    if (!Number.isFinite(remoteUpdatedMs)) return false;
    return remoteUpdatedMs > localStat.mtimeMs + 1000;
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
    findArchiveFile: archives.findArchiveFile,
    materializeAuthNow: auth.materializeAuthNow,
    prepareWorkspaceSource,
    restoreCheckpoint,
    secretFileInventory: auth.secretFileInventory,
    extractStorageArchive: archives.extractStorageArchive,
    syncArchivesDown: async (options = {}) => isMountedWorkspaceMode(config.workspaceStorageMode) ?
      {ok: true, skipped: true, reason: "shared_gcsfuse_authoritative"} : archives.syncArchivesDown(options),
    syncArchivesUp: async () => isMountedWorkspaceMode(config.workspaceStorageMode) ?
      {ok: true, skipped: true, reason: "shared_gcsfuse_authoritative"} : archives.syncArchivesUp(),
    syncDown,
    syncUp,
    synchronizeAuth: auth.synchronizeAuth,
  };
}

module.exports = {
  createWorkspaceService,
};
