"use strict";

const {normalizeEnvString, normalizeRelativeWorkspacePath} = require("./utils");
const {
  isDirectoryMarkerFileName,
  isInternalStorageDirName,
} = require("./runtimePaths");

function normalizeBranchDescription(value) {
  return normalizeEnvString(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "session";
}

function normalizeCommitTitle(value) {
  return normalizeEnvString(value).replace(/\s+/g, " ").slice(0, 160) || "Mapache session";
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
    if (isInternalStorageDirName(parts[0]) || parts.some((part) => isDirectoryMarkerFileName(part))) {
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

function normalizeGitPullRequestPayload(payload) {
  const value = payload && typeof payload === "object" ? payload : {};
  return {
    baseBranch: normalizeGitBranchName(value.baseBranch, {required: true}),
    workingBranchName: normalizeGitBranchName(value.workingBranchName),
    pushUsername: normalizeEnvString(value.pushUsername) || "x-access-token",
    pushToken: normalizeEnvString(value.pushToken),
  };
}

function normalizeGitPushAuthPayload(payload) {
  const value = payload && typeof payload === "object" ? payload : {};
  return {
    pushUsername: normalizeEnvString(value.pushUsername) || "x-access-token",
    pushToken: normalizeEnvString(value.pushToken),
  };
}

function normalizeGitBranchName(value, options = {}) {
  const branch = normalizeEnvString(value).replace(/^\/+/g, "").replace(/\/+$/g, "");
  if (!branch) {
    if (options.required) {
      throw new Error("missing_git_branch");
    }
    return "";
  }
  if (
    branch.length > 120 ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("@{") ||
    /[~^:?\\\s]/.test(branch)
  ) {
    throw new Error("invalid_git_branch");
  }
  return branch;
}

module.exports = {
  normalizeBranchDescription,
  normalizeCommitTitle,
  normalizeGitActionPaths,
  normalizeGitBranchName,
  normalizeGitCommitMessage,
  normalizeGitPullRequestPayload,
  normalizeGitPushAuthPayload,
};
