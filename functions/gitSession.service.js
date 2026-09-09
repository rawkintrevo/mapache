"use strict";

const {cleanName, httpError} = require("./backendUtils.helpers");
const {cleanGithubNumericId} = require("./github.service");
const {normalizeWorkspaceFilePath} = require("./workspace.service");

function createGitSessionService(dependencies = {}) {
  return {
    commitGit: (uid, workspaceId, sessionId, payload) =>
      commitGit(uid, workspaceId, sessionId, payload, dependencies),
    getGitStatusSummary: (uid, workspaceId, sessionId) =>
      getGitStatusSummary(uid, workspaceId, sessionId, dependencies),
    openPullRequest: (uid, workspaceId, sessionId, payload) =>
      openPullRequest(uid, workspaceId, sessionId, payload, dependencies),
    pullGit: (uid, workspaceId, sessionId) => pullGit(uid, workspaceId, sessionId, dependencies),
    pushGit: (uid, workspaceId, sessionId) => pushGit(uid, workspaceId, sessionId, dependencies),
    stageGit: (uid, workspaceId, sessionId, payload) =>
      stageGit(uid, workspaceId, sessionId, payload, dependencies),
    unstageGit: (uid, workspaceId, sessionId, payload) =>
      unstageGit(uid, workspaceId, sessionId, payload, dependencies),
  };
}

async function getGitStatusSummary(uid, workspaceId, sessionId, dependencies = {}) {
  const session = await requireGitSession(uid, workspaceId, sessionId, dependencies, {
    unavailableError: "runner_git_status_unavailable",
  });
  return dependencies.requestRunnerJson(session, "/git/status", {
    unavailableError: "runner_git_status_unavailable",
  });
}

async function pullGit(uid, workspaceId, sessionId, dependencies = {}) {
  const session = await requireGitSession(uid, workspaceId, sessionId, dependencies, {
    unavailableError: "runner_git_pull_unavailable",
  });
  return dependencies.requestRunnerJson(session, "/git/pull", {
    method: "POST",
    unavailableError: "runner_git_pull_unavailable",
  });
}

async function stageGit(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const session = await requireGitSession(uid, workspaceId, sessionId, dependencies, {
    unavailableError: "runner_git_stage_unavailable",
  });
  return dependencies.requestRunnerJson(session, "/git/stage", {
    method: "POST",
    body: {paths: normalizeGitActionPayloadPaths(payload)},
    unavailableError: "runner_git_stage_unavailable",
  });
}

async function unstageGit(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const session = await requireGitSession(uid, workspaceId, sessionId, dependencies, {
    unavailableError: "runner_git_unstage_unavailable",
  });
  return dependencies.requestRunnerJson(session, "/git/unstage", {
    method: "POST",
    body: {paths: normalizeGitActionPayloadPaths(payload)},
    unavailableError: "runner_git_unstage_unavailable",
  });
}

async function commitGit(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const session = await requireGitSession(uid, workspaceId, sessionId, dependencies, {
    unavailableError: "runner_git_commit_unavailable",
  });
  return dependencies.requestRunnerJson(session, "/git/commit", {
    method: "POST",
    body: {message: normalizeGitCommitMessage(payload)},
    unavailableError: "runner_git_commit_unavailable",
  });
}

async function pushGit(uid, workspaceId, sessionId, dependencies = {}) {
  const session = await requireGitSession(uid, workspaceId, sessionId, dependencies, {
    unavailableError: "runner_git_push_unavailable",
  });
  if (cleanName(session.sourceType) === "github" && cleanName(session.sourceMode) === "connected") {
    const installationId = cleanGithubNumericId(session.sourceInstallationId);
    if (!installationId) {
      throw httpError(503, "github_push_auth_unavailable");
    }
    const tokenResponse = await dependencies.githubService.createGithubInstallationToken(installationId);
    return requestRunnerGitPush(session, {
      pushToken: tokenResponse.token,
      pushUsername: "x-access-token",
    }, dependencies);
  }
  return requestRunnerGitPush(session, undefined, dependencies);
}

async function openPullRequest(uid, workspaceId, sessionId, payload, dependencies = {}) {
  const session = await requireGitSession(uid, workspaceId, sessionId, dependencies, {requireShutdownToken: false});
  return dependencies.githubService.openPullRequestForSession(
      session,
      payload,
      (runnerSession, body) => requestRunnerGitOpenPr(runnerSession, body, dependencies),
  );
}

async function requireGitSession(uid, workspaceId, sessionId, dependencies = {}, options = {}) {
  if (options.requireGitWorkspace !== false) await dependencies.requireWorkspace(uid, workspaceId);
  const {sessionSnap} = await dependencies.requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...sessionSnap.data()};
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (options.requireShutdownToken !== false && !session.shutdownToken) {
    throw httpError(503, options.unavailableError || "runner_git_request_unavailable");
  }
  return session;
}

function requestRunnerGitPush(session, body, dependencies) {
  return dependencies.requestRunnerJson(session, "/git/push", {
    method: "POST",
    body,
    unavailableError: "runner_git_push_unavailable",
  });
}

function requestRunnerGitOpenPr(session, body, dependencies) {
  return dependencies.requestRunnerJson(session, "/git/open-pr", {
    method: "POST",
    body,
    unavailableError: "runner_git_open_pr_unavailable",
  });
}

function normalizeGitActionPayloadPaths(payload) {
  const paths = payload && Array.isArray(payload.paths) ? payload.paths : null;
  if (!paths || !paths.length) {
    throw httpError(400, "invalid_git_paths");
  }
  return paths.map((value) => normalizeWorkspaceFilePath(value));
}

function normalizeGitCommitMessage(payload) {
  const message = cleanName(payload && payload.message ? payload.message : "").trim();
  if (!message) {
    throw httpError(400, "missing_commit_message");
  }
  return message;
}

module.exports = {
  createGitSessionService,
  normalizeGitActionPayloadPaths,
  normalizeGitCommitMessage,
};
