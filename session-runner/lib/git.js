"use strict";

const {createGitAuthService} = require("./gitAuth.service");
const {createGitCommandRunner} = require("./gitCommand.service");
const {
  buildAutomationCommitMessage,
  buildAutomationPullRequestBody,
  createGithubAutomationPullRequest,
} = require("./gitPullRequest.service");
const {parseGitPorcelainStatus} = require("./gitStatus.helpers");
const {
  normalizeBranchDescription,
  normalizeGitActionPaths,
  normalizeGitCommitMessage,
  normalizeGitPullRequestPayload,
  normalizeGitPushAuthPayload,
} = require("./gitValidation.helpers");
const {compactErrorMessage, normalizeEnvString} = require("./utils");

function createGitService({config, activity}) {
  let automationBranch = "";
  let automationBaseBranch = "";
  let automationBaseCommit = "";
  let automationPullRequest = null;
  const runGitCommand = createGitCommandRunner({config});
  const {
    withGitCloneAuth,
    withGitPushAuth,
    withGitPushPayloadAuth,
    withGithubAutomationAuth,
  } = createGitAuthService({config});

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

  function shouldAutomateGithubPullRequest() {
    return isGithubWorkspace() &&
      config.terminalKind === "pi" &&
      Boolean(config.githubAutomationToken && config.githubRepoOwner && config.githubRepoName);
  }

  async function prepareGithubAutomationBranch() {
    if (!shouldAutomateGithubPullRequest()) return null;

    automationBaseBranch = await resolveAutomationBaseBranch();
    automationBaseCommit = await runGitCommand(["rev-parse", "HEAD"], {captureStdout: true});
    console.log(`preparing GitHub automation branch from ${automationBaseBranch || automationBaseCommit || "HEAD"}`);

    await runGitCommand(["reset", "--hard", "HEAD"]);
    await runGitCommand(["clean", "-fd"]);

    if (automationBaseBranch) {
      await withGithubAutomationAuth((env) => runGitCommand(["fetch", "origin", automationBaseBranch, "--prune"], {env}));
      await runGitCommand(["checkout", "-B", automationBaseBranch, `origin/${automationBaseBranch}`]);
    }

    await runGitCommand(["reset", "--hard", "HEAD"]);
    await runGitCommand(["clean", "-fd"]);

    automationBaseCommit = await runGitCommand(["rev-parse", "HEAD"], {captureStdout: true});
    automationBranch = await uniqueAutomationBranchName();
    await runGitCommand(["checkout", "-b", automationBranch]);
    await configureAutomationCommitIdentity();
    await activity.updateSessionActivity({
      githubAutomationBranch: automationBranch,
      githubAutomationBaseBranch: automationBaseBranch || null,
      githubAutomationBaseCommit: automationBaseCommit || null,
      githubAutomationStatus: "ready",
      githubAutomationError: null,
    });
    console.log(`checked out ${automationBranch}`);
    return {
      branch: automationBranch,
      baseBranch: automationBaseBranch || null,
      baseCommit: automationBaseCommit || null,
    };
  }

  async function finalizeGithubAutomationBranch(exitCode) {
    if (!shouldAutomateGithubPullRequest() || !automationBranch) {
      return {ok: true, skipped: true, reason: "github_automation_not_enabled"};
    }
    if (automationPullRequest) {
      return {ok: true, skipped: true, reason: "github_automation_already_finalized", pullRequest: automationPullRequest};
    }

    await activity.updateSessionActivity({
      githubAutomationStatus: "finalizing",
      githubAutomationFinishedAt: null,
      githubAutomationError: null,
    });

    try {
      await runGitCommand(["add", "-A"]);
      const status = await runGitCommand(["status", "--porcelain=1"], {captureStdout: true});
      if (status) {
        const message = buildAutomationCommitMessage({sessionName: config.sessionName});
        await runGitCommand(["commit", "-m", message]);
      }

      const commitCount = await countAutomationBranchCommits();
      if (!commitCount) {
        await activity.updateSessionActivity({
          githubAutomationStatus: "no_changes",
          githubAutomationFinishedAt: new Date().toISOString(),
        });
        console.log("github automation found no changes or commits; skipping PR");
        return {ok: true, skipped: true, reason: "no_changes"};
      }

      const message = await buildAutomationPullRequestTitle();
      await withGithubAutomationAuth((env) => (
        runGitCommand(["push", "--set-upstream", "origin", `HEAD:${automationBranch}`], {env})
      ));

      const pullRequest = await createGithubAutomationPullRequest({
        config,
        title: message,
        body: buildAutomationPullRequestBody({
          sessionName: config.sessionName,
          exitCode,
          baseCommit: automationBaseCommit,
        }),
        head: automationBranch,
        base: automationBaseBranch,
      });
      automationPullRequest = pullRequest;
      await activity.updateSessionActivity({
        githubAutomationStatus: "pull_request_opened",
        githubAutomationFinishedAt: new Date().toISOString(),
        githubAutomationPullRequestNumber: Number(pullRequest.number || 0) || null,
        githubAutomationPullRequestUrl: normalizeEnvString(pullRequest.html_url),
      });
      console.log(`github automation opened PR ${pullRequest.html_url || `#${pullRequest.number}`}`);
      return {ok: true, pullRequest};
    } catch (error) {
      const message = compactErrorMessage(error && error.message ? error.message : error);
      await activity.updateSessionActivity({
        githubAutomationStatus: "failed",
        githubAutomationFinishedAt: new Date().toISOString(),
        githubAutomationError: message,
      });
      throw error;
    }
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

  async function resolveAutomationBaseBranch() {
    const candidates = [
      config.githubRequestedBranch,
      await runGitCommand(["branch", "--show-current"], {captureStdout: true}).catch(() => ""),
    ].map((value) => normalizeEnvString(value)).filter(Boolean);

    for (const branch of candidates) {
      if (await remoteBranchExists(branch)) return branch;
    }
    return candidates[0] || "";
  }

  async function remoteBranchExists(branch) {
    if (!branch) return false;
    const output = await withGithubAutomationAuth((env) => (
      runGitCommand(["ls-remote", "--heads", "origin", branch], {captureStdout: true, env})
    )).catch(() => "");
    return Boolean(output);
  }

  async function uniqueAutomationBranchName() {
    const base = `mapache/${normalizeBranchDescription(config.sessionName)}`;
    const suffix = normalizeBranchDescription(config.sessionId).slice(0, 12);
    const branch = suffix ? `${base}-${suffix}` : base;
    let candidate = branch;
    for (let index = 2; await branchExists(candidate); index += 1) {
      candidate = `${branch}-${index}`;
    }
    return candidate;
  }

  async function branchExists(branch) {
    const localBranch = await runGitCommand(["branch", "--list", branch], {captureStdout: true});
    if (localBranch) return true;
    return remoteBranchExists(branch);
  }

  async function configureAutomationCommitIdentity() {
    const name = await runGitCommand(["config", "--get", "user.name"], {captureStdout: true}).catch(() => "");
    if (!name) {
      await runGitCommand(["config", "user.name", "Mapache Agent"]);
    }
    const email = await runGitCommand(["config", "--get", "user.email"], {captureStdout: true}).catch(() => "");
    if (!email) {
      await runGitCommand(["config", "user.email", "mapache-agent@users.noreply.github.com"]);
    }
  }

  async function buildAutomationPullRequestTitle() {
    const baseRef = automationBaseBranch ? `origin/${automationBaseBranch}` : automationBaseCommit;
    if (baseRef) {
      try {
        const subjects = await runGitCommand(["log", "--reverse", "--format=%s", `${baseRef}..HEAD`], {
          captureStdout: true,
        });
        const firstSubject = String(subjects || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
        if (firstSubject) return firstSubject.slice(0, 256);
      } catch (error) {
        // Fall back to the generic session title below.
      }
    }
    return buildAutomationCommitMessage({sessionName: config.sessionName});
  }

  async function countAutomationBranchCommits() {
    const baseRef = automationBaseBranch ? `origin/${automationBaseBranch}` : automationBaseCommit;
    if (!baseRef) return 0;
    try {
      const count = await runGitCommand(["rev-list", "--count", `${baseRef}..HEAD`], {captureStdout: true});
      return Number.parseInt(count, 10) || 0;
    } catch (error) {
      return 0;
    }
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
    finalizeGithubAutomationBranch,
    getGitStatusSummary,
    isBlankWorkspace,
    isGithubWorkspace,
    prepareGithubAutomationBranch,
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
