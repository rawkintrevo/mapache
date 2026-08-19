"use strict";

const {cleanName, httpError} = require("./backendUtils.helpers");
const {cleanGithubNumericId, cleanGithubValue, createGithubClientService} = require("./githubClient.service");

function createGithubPullRequestService(dependencies = {}) {
  const githubClient = dependencies.githubClient || createGithubClientService(dependencies);
  return Object.freeze({
    buildWorkingBranchName,
    normalizeBranchDescription,
    normalizePullRequestBody,
    normalizePullRequestTitle,
    openPullRequestForSession: (session, payload, requestRunnerGitOpenPr) =>
      openPullRequestForSession(session, payload, requestRunnerGitOpenPr, githubClient),
  });
}

async function openPullRequestForSession(session, payload, requestRunnerGitOpenPr, githubClient) {
  if (cleanName(session.sourceType) !== "github") {
    throw httpError(400, "not_git_workspace");
  }
  if (cleanName(session.sourceMode) !== "connected") {
    throw httpError(400, "github_pr_requires_connected_repo");
  }
  if (!session.serviceUrl) throw httpError(409, "session_not_running");
  if (!session.shutdownToken) throw httpError(503, "runner_git_open_pr_unavailable");
  if (typeof requestRunnerGitOpenPr !== "function") {
    throw new Error("GitHub pull request creation requires a requestRunnerGitOpenPr dependency.");
  }

  const installationId = cleanGithubNumericId(session.sourceInstallationId);
  const owner = cleanGithubValue(session.sourceRepoOwner);
  const repo = cleanGithubValue(session.sourceRepoName);
  if (!installationId || !owner || !repo) {
    throw httpError(503, "github_pr_auth_unavailable");
  }

  const tokenResponse = await githubClient.createGithubInstallationToken(installationId);
  const repository = await githubClient.getGithubRepository(owner, repo, tokenResponse.token);
  const baseBranch = cleanGithubValue(repository.default_branch);
  if (!baseBranch) {
    throw httpError(502, "github_default_branch_unavailable");
  }

  const prepared = await requestRunnerGitOpenPr(session, {
    baseBranch,
    workingBranchName: buildWorkingBranchName(payload && payload.branchDescription),
    pushToken: tokenResponse.token,
    pushUsername: "x-access-token",
  });

  const template = await githubClient.getGithubPullRequestTemplate(owner, repo, baseBranch, tokenResponse.token);
  const title = normalizePullRequestTitle(
      (payload && payload.title) || prepared.pullRequest && prepared.pullRequest.defaultTitle,
  );
  if (!title) {
    throw httpError(400, "missing_pull_request_title");
  }

  const body = Object.prototype.hasOwnProperty.call(payload || {}, "body") ?
    normalizePullRequestBody(payload.body) :
    template.body;
  const pullRequest = await githubClient.createGithubPullRequest({
    owner,
    repo,
    token: tokenResponse.token,
    title,
    body,
    head: cleanGithubValue(prepared.pullRequest && prepared.pullRequest.branch),
    base: baseBranch,
    draft: Boolean(payload && payload.draft),
  });

  return {
    ...prepared,
    action: "open_pr",
    pullRequest: {
      number: Number(pullRequest.number || 0) || null,
      url: cleanGithubValue(pullRequest.html_url),
      title: cleanGithubValue(pullRequest.title) || title,
      draft: Boolean(pullRequest.draft),
      head: cleanGithubValue(pullRequest.head && pullRequest.head.ref) || cleanGithubValue(prepared.pullRequest && prepared.pullRequest.branch),
      base: cleanGithubValue(pullRequest.base && pullRequest.base.ref) || baseBranch,
      bodySource: template.source,
    },
  };
}

function buildWorkingBranchName(value) {
  const slug = normalizeBranchDescription(value);
  return slug ? `mapache/${slug}` : "";
}

function normalizeBranchDescription(value) {
  return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
}

function normalizePullRequestTitle(value) {
  return String(value || "").trim().slice(0, 256);
}

function normalizePullRequestBody(value) {
  return String(value || "").trim().slice(0, 20000);
}

module.exports = {
  buildWorkingBranchName,
  createGithubPullRequestService,
  normalizeBranchDescription,
  normalizePullRequestBody,
  normalizePullRequestTitle,
};
