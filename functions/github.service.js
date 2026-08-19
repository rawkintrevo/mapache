"use strict";

const logger = require("firebase-functions/logger");
const {
  db,
} = require("./backendContext");
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

function createGithubService(dependencies = {}) {
  const githubClient = dependencies.githubClient || createGithubClientService(dependencies);
  const githubConnection = dependencies.githubConnectionService || createGithubConnectionService({
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
    listConnectedRepos: (uid) => listConnectedRepos(uid, githubClient),
    normalizeConnectedGithubSourcePayload: (uid, source, options) =>
      normalizeConnectedGithubSourcePayload(uid, source, options, githubClient, githubConnection),
    openPullRequestForSession: (session, payload, requestRunnerGitOpenPr) =>
      openPullRequestForSession(session, payload, requestRunnerGitOpenPr, githubClient),
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

async function listConnectedRepos(uid, githubClient) {
  if (!githubClient.isGithubAppConfigured()) {
    throw httpError(503, "github_app_not_configured");
  }

  const [userSnap, installationSnap] = await Promise.all([
    githubUserDoc(uid).get(),
    githubInstallationCollection(uid).get(),
  ]);
  const userData = userSnap.exists ? userSnap.data() || {} : {};
  const connectionStatus = cleanName(userData.connectionStatus).toLowerCase();
  if (connectionStatus === "disconnected") {
    return {repos: []};
  }

  const allowedInstallationIds = new Set(normalizeGithubInstallationIds(userData.installationIds));
  const installations = installationSnap.docs
      .map((doc) => normalizeGithubInstallationRecord(uid, doc.id, doc.data(), allowedInstallationIds))
      .filter(Boolean);

  const repos = [];
  for (const installation of installations) {
    let tokenResponse;
    try {
      tokenResponse = await githubClient.createGithubInstallationToken(installation.installationId);
    } catch (error) {
      if (isGithubInstallationNotFoundError(error)) {
        logger.warn("github installation missing during repo listing", {
          installationId: installation.installationId,
          uid,
        });
        continue;
      }
      throw error;
    }

    const storedRepos = await listStoredGithubInstallationRepositories(uid, installation.installationId);
    const liveRepos = await githubClient.listGithubInstallationRepositories(
        installation.installationId,
        tokenResponse.token,
    );
    const repoMap = new Map();

    storedRepos.forEach((repo) => {
      repoMap.set(githubRepoMapKey(repo), repo);
    });

    liveRepos.forEach((repo) => {
      const normalizedRepo = normalizeGithubConnectedRepo(
          installation,
          repo,
          repoMap.get(githubRepoMapKey(repo)) || null,
          tokenResponse.repositorySelection,
      );
      if (normalizedRepo) {
        repos.push(normalizedRepo);
      }
    });
  }

  repos.sort((left, right) => {
    const leftKey = `${left.fullName || ""} ${left.installationId || ""}`.trim();
    const rightKey = `${right.fullName || ""} ${right.installationId || ""}`.trim();
    return leftKey.localeCompare(rightKey);
  });

  return {repos};
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

function githubUserDoc(uid) {
  return db.collection("githubUsers").doc(uid);
}

function githubInstallationCollection(uid) {
  return githubUserDoc(uid).collection("installations");
}

function githubInstallationRepoCollection(uid, installationId) {
  return githubInstallationCollection(uid).doc(installationId).collection("repositories");
}

async function listStoredGithubInstallationRepositories(uid, installationId) {
  const snap = await githubInstallationRepoCollection(uid, installationId).get();
  return snap.docs
      .map((doc) => normalizeStoredGithubRepositoryRecord(uid, installationId, doc.id, doc.data()))
      .filter(Boolean);
}

function normalizeStoredGithubRepositoryRecord(uid, installationId, docId, value) {
  const ownerUid = cleanGithubValue(value && value.ownerUid);
  if (ownerUid && ownerUid !== uid) {
    return null;
  }
  if (value && value.accessible === false) {
    return null;
  }

  const normalizedInstallationId = cleanGithubNumericId(value && value.installationId) || installationId;
  if (normalizedInstallationId !== installationId) {
    return null;
  }

  const repoId = cleanGithubNumericId(docId || value && value.repoId);
  const owner = cleanGithubValue(value && (value.ownerLogin || value.owner));
  const name = cleanGithubValue(value && value.name);
  const fullName = cleanGithubValue(value && (value.fullName || (owner && name ? `${owner}/${name}` : "")));
  if (!repoId && !fullName) {
    return null;
  }

  return {
    repoId,
    owner,
    name,
    fullName,
    defaultBranch: cleanGithubValue(value && value.defaultBranch),
    private: Boolean(value && value.private),
    cloneUrl: cleanGithubValue(value && value.cloneUrl),
    htmlUrl: cleanGithubValue(value && value.htmlUrl),
  };
}

function githubRepoMapKey(value) {
  const repoId = cleanGithubNumericId(value && (value.id || value.repoId));
  if (repoId) {
    return `id:${repoId}`;
  }

  const owner = cleanGithubValue(value && (value.owner && value.owner.login || value.ownerLogin || value.owner));
  const name = cleanGithubValue(value && (value.name || value.repo));
  if (owner && name) {
    return `name:${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  const fullName = cleanGithubValue(value && (value.full_name || value.fullName));
  return fullName ? `name:${fullName.toLowerCase()}` : "";
}

function normalizeGithubConnectedRepo(installation, liveRepo, storedRepo, repositorySelection) {
  const owner = cleanGithubValue(
      liveRepo && liveRepo.owner && liveRepo.owner.login ||
      storedRepo && storedRepo.owner ||
      installation && installation.githubAccountLogin,
  );
  const name = cleanGithubValue(liveRepo && liveRepo.name || storedRepo && storedRepo.name);
  const fullName = cleanGithubValue(
      liveRepo && liveRepo.full_name ||
      storedRepo && storedRepo.fullName ||
      (owner && name ? `${owner}/${name}` : ""),
  );
  if (!owner || !name || !fullName) {
    return null;
  }

  const cloneUrl = cleanGithubValue(
      liveRepo && liveRepo.clone_url ||
      storedRepo && storedRepo.cloneUrl ||
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`,
  );
  const repoUrl = cleanGithubValue(
      liveRepo && liveRepo.html_url ||
      storedRepo && storedRepo.htmlUrl ||
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );
  const isPrivate = Boolean(liveRepo && liveRepo.private != null ? liveRepo.private : storedRepo && storedRepo.private);

  return {
    repoId: cleanGithubNumericId(liveRepo && liveRepo.id || storedRepo && storedRepo.repoId),
    installationId: installation.installationId,
    owner,
    name,
    fullName,
    defaultBranch: cleanGithubValue(
        liveRepo && liveRepo.default_branch ||
        storedRepo && storedRepo.defaultBranch ||
        "main",
    ),
    private: isPrivate,
    visibility: cleanGithubValue(liveRepo && liveRepo.visibility || (isPrivate ? "private" : "public")),
    cloneUrl,
    repoUrl,
    repositorySelection: cleanGithubValue(
        repositorySelection || installation.repositorySelection,
    ),
  };
}

function isGithubInstallationNotFoundError(error) {
  return Boolean(error && error.status === 404 && error.publicMessage === "github_installation_not_found");
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
