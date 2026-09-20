"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {runCommand: defaultRunCommand} = require("./processes");
const {isSharedGcsFuseMode} = require("./sharedWorkspace.helpers");

const SHARED_GIT_ARCHIVE_DIR = "shared-workspace/git";

function createSharedWorkspaceGitService({
  config = {},
  fsImpl = fs,
  now = () => Date.now(),
  runCommand = defaultRunCommand,
  storage,
} = {}) {
  function enabled() {
    return isSharedGcsFuseMode(config.workspaceStorageMode) && config.workspaceSourceMode === "github";
  }

  function archivePath() {
    if (!config.prefix || !config.sessionId) return "";
    const suffix = String(config.runtimeKind || "main").toLowerCase() === "automation" ?
      `runs/${cleanSegment(config.automationRunId || config.sessionId)}.tar.gz` : "main.tar.gz";
    return `${config.prefix}/${config.internalStorageDir || ".mapache-internal"}/${SHARED_GIT_ARCHIVE_DIR}/${suffix}`
        .replace(/\/+/g, "/");
  }

  function seedArchivePath() {
    if (!config.prefix) return "";
    return `${config.prefix}/${config.internalStorageDir || ".mapache-internal"}/${SHARED_GIT_ARCHIVE_DIR}/seed.tar.gz`
        .replace(/\/+/g, "/");
  }

  async function prepareForStartup() {
    if (!enabled()) return {ok: true, skipped: true};
    const privateGitDir = requirePrivateGitDir();
    await fsImpl.promises.mkdir(path.dirname(privateGitDir), {recursive: true, mode: 0o700});
    await migrateOrValidateWorkspaceGitLink(privateGitDir);
    if (!(await repositoryExists(privateGitDir))) {
      for (const remotePath of startupArchiveCandidates()) {
        if (await restoreArchive(remotePath, privateGitDir)) break;
      }
    }
    await configurePrivateRepository(privateGitDir);
    await rejectUnsupportedLayouts();
    return {
      ok: true,
      privateGitDir,
      archivePath: archivePath() || null,
    };
  }

  async function archivePrivateMetadata() {
    if (!enabled()) return {ok: true, skipped: true};
    const privateGitDir = requirePrivateGitDir();
    if (!(await repositoryExists(privateGitDir))) return {ok: true, skipped: true, reason: "no_private_repository"};
    await configurePrivateRepository(privateGitDir);
    await rejectUnsupportedLayouts();
    const remotePath = archivePath();
    if (!remotePath || !storage || !config.bucketName) {
      return {ok: true, skipped: true, reason: "git_archive_storage_unavailable"};
    }
    const tempRoot = await fsImpl.promises.mkdtemp(path.join(os.tmpdir(), "mapache-shared-git-"));
    const archiveFile = path.join(tempRoot, "repository.tar.gz");
    try {
      await runCommand("tar", ["-czf", archiveFile, "-C", privateGitDir, "."], {cwd: "/"});
      const content = await fsImpl.promises.readFile(archiveFile);
      await storage.bucket(config.bucketName).file(remotePath).save(content, {
        contentType: "application/gzip",
        resumable: false,
        metadata: {
          mapacheSharedWorkspaceGit: "1",
          mapacheGitArchiveUpdatedAt: new Date(now()).toISOString(),
        },
      });
      return {ok: true, archivePath: remotePath, byteLength: content.length};
    } finally {
      await fsImpl.promises.rm(tempRoot, {recursive: true, force: true});
    }
  }

  function requirePrivateGitDir() {
    const configuredPath = String(config.privateGitDir || "").trim();
    const privateGitDir = path.resolve(configuredPath || ".");
    if (!configuredPath || privateGitDir === path.parse(privateGitDir).root) {
      const error = new Error("Shared workspace Git metadata path is not configured");
      error.code = "shared_workspace_git_path_missing";
      throw error;
    }
    return privateGitDir;
  }

  function startupArchiveCandidates() {
    const candidates = [];
    if (String(config.runtimeKind || "main").toLowerCase() === "automation") {
      candidates.push(mainArchivePath());
    } else {
      candidates.push(archivePath());
    }
    candidates.push(seedArchivePath());
    return [...new Set(candidates.filter(Boolean))];
  }

  function mainArchivePath() {
    if (!config.prefix) return "";
    return `${config.prefix}/${config.internalStorageDir || ".mapache-internal"}/${SHARED_GIT_ARCHIVE_DIR}/main.tar.gz`
        .replace(/\/+/g, "/");
  }

  async function repositoryExists(privateGitDir) {
    return fsImpl.promises.access(path.join(privateGitDir, "HEAD"))
        .then(() => true)
        .catch(() => false);
  }

  async function migrateOrValidateWorkspaceGitLink(privateGitDir) {
    const workspaceGitPath = path.join(config.workspaceDir, ".git");
    const stat = await fsImpl.promises.lstat(workspaceGitPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) {
      await fsImpl.promises.symlink(privateGitDir, workspaceGitPath, "dir");
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = path.resolve(path.dirname(workspaceGitPath), await fsImpl.promises.readlink(workspaceGitPath));
      if (target !== privateGitDir) {
        throw gitLayoutError("shared_workspace_git_link_invalid", ".git symlink must target the private Git metadata root");
      }
      return;
    }
    if (!stat.isDirectory()) throw gitLayoutError("shared_workspace_git_metadata_exposed", ".git must not be a file in a shared worktree");
    if (await repositoryExists(privateGitDir)) {
      throw gitLayoutError("shared_workspace_git_migration_conflict", "private Git metadata already exists beside a mounted .git directory");
    }
    await fsImpl.promises.cp(workspaceGitPath, privateGitDir, {recursive: true, errorOnExist: true});
    await fsImpl.promises.rm(workspaceGitPath, {recursive: true, force: true});
    await fsImpl.promises.symlink(privateGitDir, workspaceGitPath, "dir");
  }

  async function configurePrivateRepository(privateGitDir) {
    if (!(await repositoryExists(privateGitDir))) return;
    await runCommand("git", ["config", "--file", path.join(privateGitDir, "config"), "core.fileMode", "false"], {
      cwd: config.workspaceDir,
    });
  }

  async function rejectUnsupportedLayouts() {
    if (!(await repositoryExists(requirePrivateGitDir()))) return;
    const submodules = await runCommand("git", ["ls-files", "-s"], {
      cwd: config.workspaceDir,
      captureStdout: true,
    });
    const submodule = String(submodules || "").split(/\r?\n/).find((line) => /^160000\s/.test(line));
    if (submodule) {
      const error = gitLayoutError("shared_workspace_git_submodule_unsupported", `Git submodule metadata is not supported in shared workspaces: ${submodule.slice(0, 256)}`);
      throw error;
    }
    const nested = await runCommand("find", [config.workspaceDir, "-mindepth", "2", "-name", ".git", "-print"], {
      cwd: "/",
      captureStdout: true,
    });
    const nestedPath = String(nested || "").split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    if (nestedPath) {
      throw gitLayoutError("shared_workspace_git_nested_unsupported", `Nested Git metadata is not supported in shared workspaces: ${nestedPath}`);
    }
  }

  async function restoreArchive(remotePath, privateGitDir) {
    if (!storage || !config.bucketName || !remotePath) return false;
    const file = storage.bucket(config.bucketName).file(remotePath);
    const [exists] = await file.exists().catch((error) => {
      if (error?.code === 404 || error?.code === "ENOENT") return [false];
      throw error;
    });
    if (!exists) return false;
    const [content] = await file.download();
    const tempRoot = await fsImpl.promises.mkdtemp(path.join(os.tmpdir(), "mapache-shared-git-restore-"));
    const archiveFile = path.join(tempRoot, "repository.tar.gz");
    try {
      await fsImpl.promises.writeFile(archiveFile, content);
      const listing = await runCommand("tar", ["-tzf", archiveFile], {cwd: "/", captureStdout: true});
      validateArchiveListing(listing);
      await fsImpl.promises.mkdir(privateGitDir, {recursive: true, mode: 0o700});
      await runCommand("tar", ["-xzf", archiveFile, "--no-same-owner", "--no-same-permissions", "-C", privateGitDir], {cwd: "/"});
      return true;
    } finally {
      await fsImpl.promises.rm(tempRoot, {recursive: true, force: true});
    }
  }

  return {
    archivePath,
    archivePrivateMetadata,
    enabled,
    mainArchivePath,
    prepareForStartup,
    seedArchivePath,
  };
}

function validateArchiveListing(listing) {
  for (const rawEntry of String(listing || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const entry = rawEntry.replace(/^\.\//, "");
    if (!entry) continue;
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      throw gitLayoutError("shared_workspace_git_archive_invalid", `Git archive contains an unsafe path: ${rawEntry}`);
    }
  }
}

function cleanSegment(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 160) || "run";
}

function gitLayoutError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  SHARED_GIT_ARCHIVE_DIR,
  createSharedWorkspaceGitService,
  validateArchiveListing,
};
