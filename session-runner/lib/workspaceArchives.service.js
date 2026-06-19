"use strict";

const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");
const {pipeline} = require("stream/promises");
const {collectStderr, waitForChild} = require("./processes");
const {pathExists} = require("./utils");
const {legacyInternalStoragePathVariants} = require("./runtimePaths");

function archiveRemotePath(config, fileName) {
  if (!config.prefix) return "";
  return `${config.prefix}/${config.archiveStorageDir}/${fileName}`.replace(/\/+/g, "/");
}

function homeArchiveRemotePath(config) {
  if (!config.homeStoragePrefix || config.homeSyncMode === "ephemeral") return "";
  return `${config.homeStoragePrefix}/${config.homeArchiveName || "home.tar.gz"}`.replace(/\/+/g, "/");
}

function legacyArchiveRemotePaths(config, remotePath) {
  if (!remotePath) return [];
  const archives = [
    ...legacyInternalStoragePathVariants(remotePath).map((path) => ({
      bucketName: config.bucketName,
      remotePath: path,
    })),
  ];
  if (remotePath.startsWith(`${config.prefix}/${config.archiveStorageDir}/`)) {
    for (const legacyArchiveStorageDir of config.legacyArchiveStorageDirs || []) {
      archives.push({
        bucketName: config.bucketName,
        remotePath: `${config.prefix}/${legacyArchiveStorageDir}/${remotePath.split("/").pop()}`
            .replace(/\/+/g, "/"),
      });
    }
  }
  return archives.filter((archive, index, list) => {
    if (!archive.remotePath || archive.remotePath === remotePath) {
      return false;
    }
    return list.findIndex((candidate) =>
      candidate.bucketName === archive.bucketName &&
        candidate.remotePath === archive.remotePath,
    ) === index;
  });
}

function createArchiveSyncTargets({config, git}) {
  const targets = [
    {
      name: "workspace-node-modules",
      mode: "workspaceNodeModules",
      localPath: config.workspaceDir,
      remotePath: archiveRemotePath(config, "workspace-node_modules.tar.gz"),
      fallbackArchives: legacyArchiveRemotePaths(config, archiveRemotePath(config, "workspace-node_modules.tar.gz")),
      ensureLocalPath: true,
      restoreOnStartup: true,
    },
    {
      name: "workspace-pi-npm",
      mode: "directory",
      localPath: path.join(config.workspaceDir, ".pi", "npm"),
      remotePath: archiveRemotePath(config, "workspace-pi-npm.tar.gz"),
      fallbackArchives: legacyArchiveRemotePaths(config, archiveRemotePath(config, "workspace-pi-npm.tar.gz")),
      ensureLocalPath: false,
      restoreOnStartup: true,
    },
    {
      name: "workspace-pi-git",
      mode: "directory",
      localPath: path.join(config.workspaceDir, ".pi", "git"),
      remotePath: archiveRemotePath(config, "workspace-pi-git.tar.gz"),
      fallbackArchives: legacyArchiveRemotePaths(config, archiveRemotePath(config, "workspace-pi-git.tar.gz")),
      ensureLocalPath: false,
      restoreOnStartup: true,
    },
    {
      name: "home",
      mode: "directory",
      localPath: config.homeDir,
      bucketName: config.homeStorageBucketName,
      remotePath: homeArchiveRemotePath(config),
      fallbackArchives: legacyArchiveRemotePaths({
        ...config,
        bucketName: config.homeStorageBucketName,
      }, homeArchiveRemotePath(config)),
      ensureLocalPath: true,
      restoreOnStartup: config.homeSyncMode !== "ephemeral",
    },
  ];

  if (config.codexHomeStoragePrefix) {
    targets.push({
      name: "codex-home",
      mode: "directory",
      localPath: config.codexHomeDir,
      bucketName: config.codexHomeStorageBucketName,
      remotePath: `${config.codexHomeStoragePrefix}/codex-home.tar.gz`.replace(/\/+/g, "/"),
      fallbackArchives: legacyArchiveRemotePaths(
          {
            ...config,
            bucketName: config.codexHomeStorageBucketName,
          },
          `${config.codexHomeStoragePrefix}/codex-home.tar.gz`.replace(/\/+/g, "/"),
      ),
      ensureLocalPath: true,
      restoreOnStartup: true,
    });
  }

  if (git.isGithubWorkspace()) {
    targets.push({
      name: "workspace-git",
      mode: "workspaceGit",
      localPath: path.join(config.workspaceDir, ".git"),
      remotePath: archiveRemotePath(config, "workspace-git.tar.gz"),
      fallbackArchives: legacyArchiveRemotePaths(config, archiveRemotePath(config, "workspace-git.tar.gz")),
      ensureLocalPath: false,
      restoreOnStartup: true,
    });
  }

  return targets;
}

function createWorkspaceArchiveService({config, git, pathHelpers, storage}) {
  const archiveSyncTargets = createArchiveSyncTargets({config, git});

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
      if (pathHelpers.shouldIgnoreInternalWorkspacePath(relativePath)) return [];
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

  function tarExcludeArgs(target) {
    return (target.exclude || []).map((pattern) => `--exclude=${pattern}`);
  }

  return {
    archiveFile,
    archiveSyncTargets,
    extractStorageArchive,
    findArchiveFile,
    syncArchivesDown,
    syncArchivesUp,
  };
}

module.exports = {
  archiveRemotePath,
  createArchiveSyncTargets,
  createWorkspaceArchiveService,
  homeArchiveRemotePath,
};
