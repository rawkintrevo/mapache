"use strict";

const path = require("path");
const {
  matchesSyncPolicyPattern,
  normalizeRelativeWorkspacePath,
} = require("./utils");
const {
  isDirectoryMarkerFileName,
  isInternalStorageDirName,
} = require("./runtimePaths");

function isWorkspacePiPackageCachePath(parts) {
  return parts[0] === ".pi" && (parts[1] === "npm" || parts[1] === "git");
}

function createWorkspacePathHelpers({config}) {
  function shouldIgnoreWorkspacePath(relativePath) {
    const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
    const parts = normalizedPath.split("/").filter(Boolean);
    if (parts.includes("node_modules") || isInternalStorageDirName(parts[0]) || isWorkspacePiPackageCachePath(parts)) {
      return true;
    }
    return config.workspaceSyncPolicyExclude.some((pattern) => matchesSyncPolicyPattern(normalizedPath, pattern));
  }

  function shouldIgnoreInternalWorkspacePath(relativePath) {
    const firstPart = String(relativePath || "").split(path.sep).filter(Boolean)[0] || "";
    return isInternalStorageDirName(firstPart);
  }

  function normalizeRemoteWorkspacePath(remotePath) {
    return normalizeRelativeWorkspacePath(String(remotePath || "").slice(config.prefix.length).replace(/^\/+/, ""));
  }

  function shouldManageWorkspaceRemotePath(remotePath) {
    if (!remotePath || remotePath.endsWith("/")) return false;
    const relative = normalizeRemoteWorkspacePath(remotePath);
    if (!relative) return false;
    if (isDirectoryMarkerFileName(relative)) return false;
    if (isInternalStorageDirName(relative) || isInternalStorageDirName(relative.split("/")[0])) {
      return false;
    }
    return !shouldIgnoreWorkspacePath(relative);
  }

  function workspaceRemotePath(relativePath) {
    return `${config.prefix}/${normalizeRelativeWorkspacePath(relativePath)}`.replace(/\/+/g, "/");
  }

  return {
    normalizeRemoteWorkspacePath,
    shouldIgnoreInternalWorkspacePath,
    shouldIgnoreWorkspacePath,
    shouldManageWorkspaceRemotePath,
    shouldManageGithubWorktreeRemotePath: shouldManageWorkspaceRemotePath,
    workspaceRemotePath,
  };
}

module.exports = {
  createWorkspacePathHelpers,
  isWorkspacePiPackageCachePath,
};
