"use strict";

const {
  cleanName,
  httpError,
} = require("./backendUtils.helpers");
const {
  cleanGithubApiMessage,
  cleanGithubErrorBody,
  cleanGithubNumericId,
  cleanGithubValue,
  createGithubClientService,
  encodeGithubContentPath,
  normalizeGithubInstallationId,
  normalizeGithubTokenPermissions,
} = require("./githubClient.service");
const {
  createGithubConnectionService,
  normalizeGithubConnectionStatus,
  normalizeGithubInstallationIds,
  normalizeGithubInstallationRecord,
  normalizeGithubReturnTo,
} = require("./githubConnection.service");
const {
  createGithubPullRequestService,
  buildWorkingBranchName,
  normalizeBranchDescription,
  normalizePullRequestBody,
  normalizePullRequestTitle,
} = require("./githubPullRequest.service");
const {
  createGithubRepositoryCatalogService,
  githubRepoMapKey,
  normalizeGithubConnectedRepo,
  normalizeStoredGithubRepositoryRecord,
} = require("./githubRepositoryCatalog.service");

function createGithubService(dependencies = {}) {
  const githubClient = dependencies.githubClient || createGithubClientService(dependencies);
  const githubConnection = dependencies.githubConnectionService || createGithubConnectionService({
    ...dependencies,
    githubClient,
  });
  const githubRepositoryCatalog = dependencies.githubRepositoryCatalogService || createGithubRepositoryCatalogService({
    ...dependencies,
    githubClient,
  });
  const githubPullRequest = dependencies.githubPullRequestService || createGithubPullRequestService({
    ...dependencies,
    githubClient,
  });
  return {
    buildGithubAuthEnv: (session) => buildGithubAuthEnv(session, githubClient),
    createGithubConnectUrl: githubConnection.createGithubConnectUrl,
    createGithubInstallationToken: githubClient.createGithubInstallationToken,
    disconnectGithub: githubConnection.disconnectGithub,
    getGithubConnection: githubConnection.getGithubConnection,
    handleGithubCallback: githubConnection.handleGithubCallback,
    isConnectedGithubSourcePayload,
    listConnectedRepos: githubRepositoryCatalog.listConnectedRepos,
    normalizeConnectedGithubSourcePayload: (uid, source, options) =>
      normalizeConnectedGithubSourcePayload(uid, source, options, githubClient, githubConnection),
    openPullRequestForSession: githubPullRequest.openPullRequestForSession,
    sessionSourceMetadata,
  };
}

function isConnectedGithubSourcePayload(source) {
  const mode = cleanName(source && source.mode).toLowerCase();
  if (mode === "connected") {
    return true;
  }
  return Boolean(cleanGithubNumericId(source && source.installationId) || cleanGithubNumericId(source && source.repoId));
}

async function normalizeConnectedGithubSourcePayload(uid, source, options = {}, githubClient, githubConnection) {
  if (!githubClient.isGithubAppConfigured()) {
    throw httpError(503, "github_app_not_configured");
  }

  const installationId = normalizeGithubInstallationId(source.installationId);
  const expectedRepoId = cleanGithubNumericId(source.repoId);
  const expectedOwner = cleanGithubValue(source.owner).toLowerCase();
  const expectedRepo = cleanGithubValue(source.repo).toLowerCase();
  const requestedRepoUrl = cleanGithubValue(source.repoUrl || source.url);
  await githubConnection.requireGithubInstallationForUser(uid, installationId);
  const tokenResponse = await githubClient.createGithubInstallationToken(installationId);
  const repos = await githubClient.listGithubInstallationRepositories(installationId, tokenResponse.token);
  const matchedRepo = repos.find((repo) => {
    const liveRepoId = cleanGithubNumericId(repo && repo.id);
    const liveOwner = cleanGithubValue(repo && repo.owner && repo.owner.login).toLowerCase();
    const liveName = cleanGithubValue(repo && repo.name).toLowerCase();
    const liveCloneUrl = cleanGithubValue(repo && repo.clone_url);
    if (expectedRepoId && liveRepoId) {
      return expectedRepoId === liveRepoId;
    }
    if (expectedOwner && expectedRepo) {
      return expectedOwner === liveOwner && expectedRepo === liveName;
    }
    return Boolean(requestedRepoUrl && liveCloneUrl && requestedRepoUrl === liveCloneUrl);
  });

  if (!matchedRepo) {
    throw httpError(403, "github_connected_repo_forbidden");
  }

  const owner = cleanGithubValue(matchedRepo.owner && matchedRepo.owner.login);
  const repo = cleanGithubValue(matchedRepo.name);
  const cloneUrl = cleanGithubValue(matchedRepo.clone_url);
  const repoId = cleanGithubNumericId(matchedRepo.id);
  if (!owner || !repo || !cloneUrl || !repoId) {
    throw httpError(502, "github_connected_repo_invalid");
  }

  return {
    type: "github",
    mode: "connected",
    repoUrl: cloneUrl,
    owner,
    repo,
    requestedBranch: options.requestedBranch || cleanGithubValue(matchedRepo.default_branch) || null,
    requestedCommit: options.requestedCommit || null,
    visibility: matchedRepo.private ? "private" : "public",
    connection: {
      installationId,
      repoId,
      ownerUid: uid,
    },
  };
}

async function buildGithubAuthEnv(session, githubClient) {
  if (cleanName(session.sourceType) !== "github") {
    return [];
  }

  if (cleanName(session.sourceMode) !== "connected") {
    return [];
  }

  const installationId = cleanGithubNumericId(session.sourceInstallationId);
  if (!installationId) {
    throw httpError(503, "github_auth_unavailable");
  }

  const tokenResponse = await githubClient.createGithubInstallationToken(installationId);
  const env = [
    {name: "GITHUB_AUTOMATION_USERNAME", value: "x-access-token"},
    {name: "GITHUB_AUTOMATION_TOKEN", value: tokenResponse.token},
  ];

  if (cleanName(session.sourceVisibility) === "private") {
    env.push(
        {name: "GITHUB_CLONE_USERNAME", value: "x-access-token"},
        {name: "GITHUB_CLONE_TOKEN", value: tokenResponse.token},
    );
  }

  return env;
}

function sessionSourceMetadata(workspace) {
  const source = workspace && workspace.source ? workspace.source : {type: "blank"};
  if (source.type !== "github") {
    return {sourceType: "blank"};
  }

  return {
    sourceType: "github",
    sourceMode: cleanName(source.mode || "public"),
    sourceVisibility: cleanName(source.visibility || "public"),
    sourceRepoUrl: cleanName(source.repoUrl || ""),
    sourceRepoOwner: cleanName(source.owner || ""),
    sourceRepoName: cleanName(source.repo || ""),
    sourceRequestedBranch: cleanName(source.requestedBranch || ""),
    sourceRequestedCommit: cleanName(source.requestedCommit || ""),
    sourceResolvedBranch: cleanName(source.resolvedBranch || ""),
    sourceResolvedCommit: cleanName(source.resolvedCommit || ""),
    sourceInstallationId: cleanGithubNumericId(source.connection && source.connection.installationId),
    sourceRepoId: cleanGithubNumericId(source.connection && source.connection.repoId),
  };
}

module.exports = {
  buildWorkingBranchName,
  cleanGithubApiMessage,
  cleanGithubErrorBody,
  cleanGithubNumericId,
  cleanGithubValue,
  createGithubService,
  encodeGithubContentPath,
  githubRepoMapKey,
  isConnectedGithubSourcePayload,
  normalizeBranchDescription,
  normalizeGithubConnectionStatus,
  normalizeGithubConnectedRepo,
  normalizeGithubInstallationId,
  normalizeGithubInstallationIds,
  normalizeGithubInstallationRecord,
  normalizeGithubReturnTo,
  normalizeGithubTokenPermissions,
  normalizePullRequestBody,
  normalizePullRequestTitle,
  normalizeStoredGithubRepositoryRecord,
  sessionSourceMetadata,
};
