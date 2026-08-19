"use strict";

const {createGitAuthService} = require("./gitAuth.service");
const {createGitCommandRunner} = require("./gitCommand.service");
const {
  buildAutomationCommitMessage,
  buildAutomationPullRequestBody,
  createGithubAutomationPullRequest,
} = require("./gitPullRequest.service");
const {createGithubAutomationService} = require("./gitAutomation.service");
const {parseGitPorcelainStatus} = require("./gitStatus.helpers");
const {
  normalizeGitActionPaths,
  normalizeGitCommitMessage,
  normalizeGitPullRequestPayload,
  normalizeGitPushAuthPayload,
} = require("./gitValidation.helpers");
const {compactErrorMessage} = require("./utils");

function createGitService({config, activity}) {
  const runGitCommand = createGitCommandRunner({config});
  const {
    withGitCloneAuth,
    withGitPushAuth,
    withGitPushPayloadAuth,
    withGithubAutomationAuth,
  } = createGitAuthService({config});
  const automation = createGithubAutomationService({
    activity,
    buildAutomationCommitMessage,
    buildAutomationPullRequestBody,
    config,
    createGithubAutomationPullRequest,
    runGitCommand,
    withGithubAutomationAuth,
  });

  function isGithubWorkspace() {
    return config.workspaceSourceMode === "github";
  }

  function isBlankWorkspace() {
    return config.workspaceSourceMode !== "github";
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

  async function pushGitChanges(auth = {}) {
    const branch = await runGitCommand(["branch", "--show-current"], {captureStdout: true});
    if (!branch) {
      throw new Error("git_push_no_current_branch");
    }

    const pushAuth = normalizeGitPushAuthPayload(auth);
    let push = {ok: true, message: "", branch};
    try {
      const runPush = (env) => runGitCommand(["push", "origin", `HEAD:${branch}`], {env});
      if (pushAuth.pushToken) {
        await withGitPushPayloadAuth(pushAuth, runPush);
      } else {
        await withGitPushAuth(runPush);
      }
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

  return {
    checkoutRequestedCommit,
    cloneGithubWorkspace,
    commitGitChanges,
    finalizeGithubAutomationBranch: automation.finalizeGithubAutomationBranch,
    getGitStatusSummary,
    isBlankWorkspace,
    isGithubWorkspace,
    prepareGithubAutomationBranch: automation.prepareGithubAutomationBranch,
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

module.exports = {
  classifyGithubCloneFailure,
  createGitService,
};
