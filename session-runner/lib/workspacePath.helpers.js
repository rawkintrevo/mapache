"use strict";

const path = require("path");
const {
  matchesSyncPolicyPattern,
  normalizeRelativeWorkspacePath,
} = require("./utils");

function isWorkspacePiPackageCachePath(parts) {
  return parts[0] === ".pi" && (parts[1] === "npm" || parts[1] === "git");
}

function createWorkspacePathHelpers({config}) {
  function shouldIgnoreWorkspacePath(relativePath) {
    const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
    const parts = normalizedPath.split("/").filter(Boolean);
    if (parts.includes("node_modules") || parts[0] === config.internalStorageDir || isWorkspacePiPackageCachePath(parts)) {
      return true;
    }
    return config.workspaceSyncPolicyExclude.some((pattern) => matchesSyncPolicyPattern(normalizedPath, pattern));
  }

  function shouldIgnoreInternalWorkspacePath(relativePath) {
    const firstPart = String(relativePath || "").split(path.sep).filter(Boolean)[0] || "";
    return firstPart === config.internalStorageDir;
  }

  function normalizeRemoteWorkspacePath(remotePath) {
    return normalizeRelativeWorkspacePath(String(remotePath || "").slice(config.prefix.length).replace(/^\/+/, ""));
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

  return {
    normalizeRemoteWorkspacePath,
    shouldIgnoreInternalWorkspacePath,
    shouldIgnoreWorkspacePath,
    shouldManageGithubWorktreeRemotePath,
    workspaceRemotePath,
  };
}

module.exports = {
  createWorkspacePathHelpers,
  isWorkspacePiPackageCachePath,
};
