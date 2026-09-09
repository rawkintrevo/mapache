"use strict";

const logger = require("firebase-functions/logger");
const {db: defaultDb} = require("./backendContext");
const {cleanName, httpError} = require("./backendUtils.helpers");
const {
  cleanGithubNumericId,
  cleanGithubValue,
  createGithubClientService,
} = require("./githubClient.service");
const {
  normalizeGithubInstallationIds,
  normalizeGithubInstallationRecord,
} = require("./githubConnection.service");

function createGithubRepositoryCatalogService(dependencies = {}) {
  const db = dependencies.db || defaultDb;
  const githubClient = dependencies.githubClient || createGithubClientService(dependencies);
  return Object.freeze({
    githubRepoMapKey,
    listConnectedRepos: (uid) => listConnectedRepos(uid, {db, githubClient}),
    normalizeGithubConnectedRepo,
    normalizeStoredGithubRepositoryRecord,
  });
}

async function listConnectedRepos(uid, dependencies) {
  if (!dependencies.githubClient.isGithubAppConfigured()) {
    throw httpError(503, "github_app_not_configured");
  }

  const [userSnap, installationSnap] = await Promise.all([
    githubUserDoc(dependencies.db, uid).get(),
    githubInstallationCollection(dependencies.db, uid).get(),
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
      tokenResponse = await dependencies.githubClient.createGithubInstallationToken(installation.installationId);
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

    const storedRepos = await listStoredGithubInstallationRepositories(
        dependencies.db,
        uid,
        installation.installationId,
    );
    const liveRepos = await dependencies.githubClient.listGithubInstallationRepositories(
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

async function listStoredGithubInstallationRepositories(db, uid, installationId) {
  const snap = await githubInstallationRepoCollection(db, uid, installationId).get();
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

function githubUserDoc(db, uid) {
  return db.collection("githubUsers").doc(uid);
}

function githubInstallationCollection(db, uid) {
  return githubUserDoc(db, uid).collection("installations");
}

function githubInstallationRepoCollection(db, uid, installationId) {
  return githubInstallationCollection(db, uid).doc(installationId).collection("repositories");
}

module.exports = {
  createGithubRepositoryCatalogService,
  githubRepoMapKey,
  normalizeGithubConnectedRepo,
  normalizeStoredGithubRepositoryRecord,
};
