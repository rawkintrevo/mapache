"use strict";

const assert = require("node:assert/strict");
const {createGithubAutomationTokenBrokerService} = require("./githubAutomationTokenBroker.service");

function request(body, token = "shutdown") {
  return {method: "POST", body, get: (name) => name === "x-shutdown-token" ? token : ""};
}

function harness(overrides = {}) {
  const session = {
    workspaceId: "workspace-1", ownerUid: "uid-1", status: "running", shutdownToken: "shutdown",
    sourceType: "github", sourceMode: "connected", sourceInstallationId: "42", sourceRepoId: "99",
    sourceRepoUrl: "https://github.com/acme/repo.git",
  };
  const workspace = {ownerUid: "uid-1", source: {type: "github", mode: "connected", connection: {installationId: "42", repoId: "99"}}};
  const service = createGithubAutomationTokenBrokerService({
    db: {collection: () => ({doc: () => ({get: async () => ({exists: true, data: () => workspace})})})},
    sessionCollection: () => ({doc: () => ({get: async () => ({exists: true, data: () => ({...session, ...overrides.session})})})}),
    githubConnection: {requireGithubInstallationForUser: async () => ({})},
    githubClient: {
      createGithubInstallationToken: async () => ({token: "fresh", expiresAt: "2030-01-01T00:00:00.000Z"}),
      listGithubInstallationRepositories: async () => [{id: "99", clone_url: "https://github.com/acme/repo.git"}],
    },
  });
  return service;
}

(async () => {
  const result = await harness().refreshAccessToken(request({workspaceId: "workspace-1", sessionId: "session-1"}));
  assert.deepEqual(result, {accessToken: "fresh", expiresAt: "2030-01-01T00:00:00.000Z"});
  await assert.rejects(() => harness().refreshAccessToken(request({workspaceId: "workspace-1", sessionId: "session-1"}, "wrong")), (error) => error.status === 404 && error.publicMessage === "not_found");
  await assert.rejects(() => harness({session: {status: "stopped"}}).refreshAccessToken(request({workspaceId: "workspace-1", sessionId: "session-1"})), (error) => error.status === 409);
  await assert.rejects(() => harness().refreshAccessToken({...request({workspaceId: "workspace-1", sessionId: "session-1"}), method: "GET"}), (error) => error.status === 405);
  console.log("GitHub automation-token broker service tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
