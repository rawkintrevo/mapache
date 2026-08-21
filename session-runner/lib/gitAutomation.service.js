"use strict";

const {
  buildAutomationCommitMessage: defaultBuildAutomationCommitMessage,
  buildAutomationPullRequestBody: defaultBuildAutomationPullRequestBody,
  createGithubAutomationPullRequest: defaultCreateGithubAutomationPullRequest,
} = require("./gitPullRequest.service");
const {normalizeBranchDescription} = require("./gitValidation.helpers");
const {compactErrorMessage, normalizeEnvString} = require("./utils");

const CLEAN_WORKTREE_ARGS = Object.freeze([
  "clean",
  "-fd",
  "-e",
  ".pi/skills/",
  "-e",
  ".agents/skills/",
]);

function createGithubAutomationService({
  activity,
  buildAutomationCommitMessage = defaultBuildAutomationCommitMessage,
  buildAutomationPullRequestBody = defaultBuildAutomationPullRequestBody,
  config,
  createGithubAutomationPullRequest = defaultCreateGithubAutomationPullRequest,
  runGitCommand,
  withGithubAutomationAuth,
}) {
  let automationBranch = "";
  let automationBaseBranch = "";
  let automationBaseCommit = "";
  let automationPullRequest = null;

  function shouldAutomateGithubPullRequest() {
    return config.workspaceSourceMode === "github" &&
      config.harnessId === "pi" &&
      Boolean(config.githubAutomationToken && config.githubRepoOwner && config.githubRepoName);
  }

  async function prepareGithubAutomationBranch() {
    if (!shouldAutomateGithubPullRequest()) return null;

    automationBaseBranch = await resolveAutomationBaseBranch();
    automationBaseCommit = await runGitCommand(["rev-parse", "HEAD"], {captureStdout: true});
    console.log(`preparing GitHub automation branch from ${automationBaseBranch || automationBaseCommit || "HEAD"}`);

    await runGitCommand(["reset", "--hard", "HEAD"]);
    await runGitCommand([...CLEAN_WORKTREE_ARGS]);

    if (automationBaseBranch) {
      await withGithubAutomationAuth((env) => runGitCommand(["fetch", "origin", automationBaseBranch, "--prune"], {env}));
      await runGitCommand(["checkout", "-B", automationBaseBranch, `origin/${automationBaseBranch}`]);
    }

    await runGitCommand(["reset", "--hard", "HEAD"]);
    await runGitCommand([...CLEAN_WORKTREE_ARGS]);

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

  return {
    finalizeGithubAutomationBranch,
    prepareGithubAutomationBranch,
  };
}

module.exports = {createGithubAutomationService};
