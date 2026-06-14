"use strict";

const fs = require("fs");
const path = require("path");
const {runCommand} = require("./processes");
const {
  compactErrorMessage,
  normalizeEnvString,
  normalizeRelativeWorkspacePath,
} = require("./utils");

function createGitService({config, activity}) {
  function isGithubWorkspace() {
    return config.workspaceSourceMode === "github";
  }

  function isBlankWorkspace() {
    return config.workspaceSourceMode !== "github";
  }

  async function runGitCommand(args, options = {}) {
    return runCommand("git", args, {
      captureStdout: options.captureStdout,
      cwd: options.cwd || config.workspaceDir,
      env: options.env || process.env,
    });
  }

  async function cloneGithubWorkspace() {
    if (!config.githubRepoUrl) {
      throw new Error("missing GitHub repo URL for workspace startup");
    }

    console.log(`cloning GitHub workspace from ${config.githubRepoUrl}`);
    await runGitClone();
    await checkoutRequestedCommit();
  }

  async function runGitClone() {
    const args = ["clone"];
    if (!config.githubRequestedCommit && config.githubRequestedBranch) {
      args.push("--branch", config.githubRequestedBranch, "--single-branch");
    }
    args.push(config.githubRepoUrl, config.workspaceDir);
    try {
      if (config.githubCloneToken) {
        await withGitCloneAuth((env) => runGitCommand(args, {cwd: "/", env}));
      } else {
        await runGitCommand(args, {cwd: "/"});
      }
    } catch (error) {
      throw new Error(`clone failed: ${compactErrorMessage(error.message || error)}`);
    }
  }

  async function checkoutRequestedCommit() {
    if (!config.githubRequestedCommit) return;
    console.log(`checking out requested commit ${config.githubRequestedCommit}`);
    try {
      await runGitCommand(["checkout", "--force", config.githubRequestedCommit]);
    } catch (error) {
      throw new Error(`checkout failed: ${compactErrorMessage(error.message || error)}`);
    }
  }

  async function resolveGitHead() {
    const commit = await runGitCommand(["rev-parse", "HEAD"], {captureStdout: true});
    const branch = await runGitCommand(["branch", "--show-current"], {captureStdout: true});
    return {
      branch: branch || null,
      commit: commit || config.githubRequestedCommit || null,
    };
  }

  async function recordGithubCloneFailure(error) {
    const message = compactErrorMessage(error && error.message ? error.message : error);
    const classified = classifyGithubCloneFailure(message);
    console.error("github workspace clone failed", classified.code, message);
    await publishGithubFailureState("clone_failed", classified.statusMessage, `${classified.code}: ${message}`);
  }

  async function recordGithubSyncFailure(error) {
    const message = compactErrorMessage(error && error.message ? error.message : error);
    console.error("github workspace cache restore failed", message);
    await publishGithubFailureState("sync_failed", message, `github_sync_failed: ${message}`);
  }

  async function publishGithubResolvedMetadata(resolved) {
    await Promise.all([
      activity.updateSessionActivity({
        sourceResolvedBranch: resolved.branch,
        sourceResolvedCommit: resolved.commit,
        sourceStatus: "ready",
        sourceStatusMessage: null,
        lastError: null,
      }),
      activity.updateWorkspaceSourceState({
        resolvedBranch: resolved.branch,
        resolvedCommit: resolved.commit,
        status: "ready",
        statusMessage: null,
      }),
    ]);
  }

  async function publishGithubFailureState(status, statusMessage, lastError) {
    await Promise.all([
      activity.updateSessionActivity({
        sourceStatus: status,
        sourceStatusMessage: statusMessage,
        lastError,
      }),
      activity.updateWorkspaceSourceState({
        status,
        statusMessage,
      }),
    ]);
  }

  async function getGitStatusSummary() {
    const commit = await runGitCommand(["rev-parse", "HEAD"], {captureStdout: true});
    const branch = await runGitCommand(["branch", "--show-current"], {captureStdout: true});
    const porcelain = await runGitCommand(["status", "--porcelain=1", "--branch"], {captureStdout: true});
    const parsed = parseGitPorcelainStatus(porcelain);
    return {
      ok: true,
      git: true,
      sourceType: config.workspaceSourceMode,
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

  async function prepareGitPullRequest(payload) {
    const request = normalizeGitPullRequestPayload(payload);
    const before = await getGitStatusSummary();
    let branch = before.branch;
    if (!branch) {
      throw new Error("git_pr_no_current_branch");
    }

    let createdBranch = false;
    if (branch === request.baseBranch) {
      if (!request.workingBranchName) {
        throw new Error("missing_pr_branch_description");
      }
      await ensureGitBranchDoesNotExist(request.workingBranchName, request);
      await runGitCommand(["checkout", "-b", request.workingBranchName]);
      branch = request.workingBranchName;
      createdBranch = true;
    }

    await pushGitBranchWithAuth(branch, request);
    const after = await getGitStatusSummary();
    return {
      ...after,
      action: "open_pr_prepare",
      pullRequest: {
        branch,
        baseBranch: request.baseBranch,
        createdBranch,
        defaultTitle: await getPullRequestTitleSuggestion(request.baseBranch),
      },
    };
  }

  async function ensureGitBranchDoesNotExist(branch, auth) {
    const localBranch = await runGitCommand(["branch", "--list", branch], {captureStdout: true});
    if (localBranch) {
      throw new Error("git_pr_branch_name_conflict");
    }
    const remoteBranch = await withGitPushPayloadAuth(auth, (env) => (
      runGitCommand(["ls-remote", "--heads", "origin", branch], {captureStdout: true, env})
    ));
    if (remoteBranch) {
      throw new Error("git_pr_branch_name_conflict");
    }
  }

  async function pushGitBranchWithAuth(branch, auth) {
    await withGitPushPayloadAuth(auth, (env) => (
      runGitCommand(["push", "--set-upstream", "origin", `HEAD:${branch}`], {env})
    ));
  }

  async function getPullRequestTitleSuggestion(baseBranch) {
    try {
      const messages = await runGitCommand(["log", "--reverse", "--format=%s", `origin/${baseBranch}..HEAD`], {
        captureStdout: true,
      });
      const firstMessage = String(messages || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
      if (firstMessage) {
        return firstMessage.slice(0, 256);
      }
    } catch (error) {
      // Fall back to HEAD subject below.
    }

    const headMessage = await runGitCommand(["log", "-1", "--format=%s", "HEAD"], {captureStdout: true});
    return String(headMessage || "").trim().slice(0, 256);
  }

  async function withGitAskPassAuth({token, username, userEnvName, tokenEnvName, askPassFilePrefix}, task) {
    if (!token) {
      throw new Error("github_auth_not_configured");
    }

    const askPassPath = path.join(process.env.TMPDIR || "/tmp", `${askPassFilePrefix}-${config.sessionId || "runner"}.sh`);
    await fs.promises.writeFile(askPassPath, [
      "#!/bin/sh",
      "case \"$1\" in",
      `  *Username*) printf '%s\\n' \"\${${userEnvName}:-x-access-token}\" ;;`,
      `  *) printf '%s\\n' \"\${${tokenEnvName}:-}\" ;;`,
      "esac",
      "",
    ].join("\n"), {mode: 0o700});

    try {
      return await task({
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: askPassPath,
        [userEnvName]: username || "x-access-token",
        [tokenEnvName]: token,
      });
    } finally {
      await fs.promises.rm(askPassPath, {force: true}).catch(() => {});
    }
  }

  async function withGitCloneAuth(task) {
    return withGitAskPassAuth({
      token: config.githubCloneToken,
      username: config.githubCloneUsername,
      userEnvName: "GITHUB_CLONE_USERNAME",
      tokenEnvName: "GITHUB_CLONE_TOKEN",
      askPassFilePrefix: "mapahce-git-clone-askpass",
    }, task);
  }

  async function withGitPushAuth(task) {
    const token = normalizeEnvString(process.env.GITHUB_PUSH_TOKEN);
    return withGitAskPassAuth({
      token,
      username: normalizeEnvString(process.env.GITHUB_PUSH_USERNAME) || "x-access-token",
      userEnvName: "GITHUB_PUSH_USERNAME",
      tokenEnvName: "GITHUB_PUSH_TOKEN",
      askPassFilePrefix: "mapahce-git-push-askpass",
    }, task);
  }

  async function withGitPushPayloadAuth(auth, task) {
    return withGitAskPassAuth({
      token: normalizeEnvString(auth && auth.pushToken),
      username: normalizeEnvString(auth && auth.pushUsername) || "x-access-token",
      userEnvName: "GITHUB_PUSH_USERNAME",
      tokenEnvName: "GITHUB_PUSH_TOKEN",
      askPassFilePrefix: "mapahce-git-push-askpass",
    }, task);
  }

  return {
    checkoutRequestedCommit,
    cloneGithubWorkspace,
    commitGitChanges,
    getGitStatusSummary,
    isBlankWorkspace,
    isGithubWorkspace,
    prepareGitPullRequest,
    publishGithubResolvedMetadata,
    pullGitAction,
    pushGitChanges,
    recordGithubCloneFailure,
    recordGithubSyncFailure,
    resolveGitHead,
    runGitCommand,
    stageGitPaths,
    unstageGitPaths,
  };
}

function classifyGithubCloneFailure(message) {
  const normalized = compactErrorMessage(message).toLowerCase();
  if (
    normalized.includes("authentication failed") ||
    normalized.includes("invalid username or token") ||
    normalized.includes("could not read username") ||
    normalized.includes("could not read password") ||
    normalized.includes("terminal prompts disabled") ||
    normalized.includes("access denied")
  ) {
    return {
      code: "github_clone_auth_failed",
      statusMessage: "GitHub clone auth failed.",
    };
  }

  if (
    normalized.includes("repository not found") ||
    normalized.includes("not found")
  ) {
    return {
      code: "github_clone_repo_not_found",
      statusMessage: "GitHub repository not found.",
    };
  }

  if (
    normalized.includes("could not resolve host") ||
    normalized.includes("failed to connect") ||
    normalized.includes("connection timed out") ||
    normalized.includes("connection reset") ||
    normalized.includes("network is unreachable") ||
    normalized.includes("tls")
  ) {
    return {
      code: "github_clone_network_failed",
      statusMessage: "GitHub clone network failed.",
    };
  }

  return {
    code: "github_clone_failed",
    statusMessage: "GitHub clone failed.",
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
    if (parts[0] === ".mapahce-internal" || parts.includes(".mapahce-directory")) {
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
  classifyGithubCloneFailure,
  createGitService,
};
