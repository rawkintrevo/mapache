"use strict";

const crypto = require("crypto");
const {httpError} = require("./backendUtils.helpers");
const {cleanGithubNumericId, cleanGithubValue} = require("./githubClient.service");

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function createGithubAutomationTokenBrokerService(dependencies = {}) {
  if (typeof dependencies.sessionCollection !== "function" || !dependencies.db ||
      !dependencies.githubClient || !dependencies.githubConnection) {
    throw new Error("GitHub automation-token broker requires session, database, and GitHub services.");
  }
  return {refreshAccessToken: (request) => refreshAccessToken(request, dependencies)};
}

async function refreshAccessToken(request = {}, dependencies) {
  if (String(request.method || "").toUpperCase() !== "POST") throw httpError(405, "method_not_allowed");
  const workspaceId = cleanId(request.body?.workspaceId, "invalid_workspace");
  const sessionId = cleanId(request.body?.sessionId, "invalid_session");
  const sessionSnap = await dependencies.sessionCollection(workspaceId).doc(sessionId).get();
  const session = sessionSnap.exists ? sessionSnap.data() || {} : null;
  const presented = String(request.get?.("x-shutdown-token") || "");
  if (!session || !safeTokenEqual(presented, session.shutdownToken)) throw httpError(404, "not_found");
  if (session.status !== "running" || session.workspaceId !== workspaceId || !session.ownerUid) {
    throw httpError(409, "github_token_refresh_session_unavailable");
  }
  if (String(session.sourceType || "") !== "github" || String(session.sourceMode || "") !== "connected") {
    throw httpError(409, "github_token_refresh_not_connected");
  }
  const installationId = cleanGithubNumericId(session.sourceInstallationId);
  const repoId = cleanGithubNumericId(session.sourceRepoId);
  if (!installationId || !repoId) throw httpError(409, "github_token_refresh_source_invalid");
  const workspaceSnap = await dependencies.db.collection("workspaces").doc(workspaceId).get();
  const workspace = workspaceSnap.exists ? workspaceSnap.data() || {} : null;
  const source = workspace && workspace.source;
  const sourceInstallationId = cleanGithubNumericId(source?.connection?.installationId);
  const sourceRepoId = cleanGithubNumericId(source?.connection?.repoId);
  if (!workspace || workspace.ownerUid !== session.ownerUid || source?.type !== "github" ||
      source?.mode !== "connected" || sourceInstallationId !== installationId || sourceRepoId !== repoId) {
    throw httpError(409, "github_token_refresh_source_changed");
  }
  await dependencies.githubConnection.requireGithubInstallationForUser(session.ownerUid, installationId);
  const minted = await dependencies.githubClient.createGithubInstallationToken(installationId);
  const repos = await dependencies.githubClient.listGithubInstallationRepositories(installationId, minted.token);
  const repo = repos.find((item) => cleanGithubNumericId(item?.id) === repoId);
  if (!repo || cleanGithubValue(repo.clone_url) !== cleanGithubValue(session.sourceRepoUrl)) {
    throw httpError(403, "github_token_refresh_repo_forbidden");
  }
  return {accessToken: minted.token, expiresAt: minted.expiresAt};
}

function cleanId(value, errorCode) {
  const id = String(value || "").trim();
  if (!ID.test(id)) throw httpError(400, errorCode);
  return id;
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {createGithubAutomationTokenBrokerService, refreshAccessToken, safeTokenEqual};
