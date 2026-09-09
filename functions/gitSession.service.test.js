"use strict";

const assert = require("assert");
const {
  createGitSessionService,
  normalizeGitActionPayloadPaths,
  normalizeGitCommitMessage,
} = require("./gitSession.service");

assert.deepStrictEqual(normalizeGitActionPayloadPaths({paths: ["/src/App.jsx", "README.md"]}), ["src/App.jsx", "README.md"]);
assert.throws(() => normalizeGitActionPayloadPaths({paths: []}), (error) => error.status === 400 && error.publicMessage === "invalid_git_paths");
assert.throws(() => normalizeGitActionPayloadPaths({paths: ["../secret"]}), /invalid_file_path/);
assert.strictEqual(normalizeGitCommitMessage({message: "  update app  "}), "update app");
assert.throws(() => normalizeGitCommitMessage({message: "  "}), (error) => error.status === 400 && error.publicMessage === "missing_commit_message");

const calls = [];
const baseSession = {
  serviceUrl: "https://runner.example",
  shutdownToken: "shutdown-token",
  sourceType: "blank",
};
const service = createGitSessionService({
  githubService: {
    createGithubInstallationToken: async (installationId) => {
      calls.push({kind: "token", installationId});
      return {token: "github-token"};
    },
    openPullRequestForSession: async (session, payload, requestRunnerGitOpenPr) => {
      calls.push({kind: "pr", session, payload});
      return requestRunnerGitOpenPr(session, {branchDescription: "feature"});
    },
  },
  requireWorkspace: async (...args) => calls.push({kind: "workspace", args}),
  requireSession: async (...args) => {
    calls.push({kind: "session", args});
    return {sessionSnap: {data: () => ({...baseSession})}};
  },
  requestRunnerJson: async (session, route, options) => {
    calls.push({kind: "runner", session, route, options});
    return {ok: true};
  },
});

(async () => {
  assert.deepStrictEqual(await service.getGitStatusSummary("uid", "workspace", "session"), {ok: true});
  assert.deepStrictEqual(await service.stageGit("uid", "workspace", "session", {paths: ["src/app.js"]}), {ok: true});
  assert.deepStrictEqual(await service.commitGit("uid", "workspace", "session", {message: "commit"}), {ok: true});
  assert.deepStrictEqual(await service.pushGit("uid", "workspace", "session"), {ok: true});
  assert.strictEqual(calls.filter((call) => call.kind === "workspace").length, 4);
  assert.strictEqual(calls.find((call) => call.kind === "runner" && call.route === "/git/stage").options.body.paths[0], "src/app.js");
  assert.strictEqual(calls.find((call) => call.kind === "runner" && call.route === "/git/commit").options.body.message, "commit");

  calls.length = 0;
  const connectedService = createGitSessionService({
    githubService: {
      createGithubInstallationToken: async (installationId) => {
        calls.push({kind: "token", installationId});
        return {token: "github-token"};
      },
      openPullRequestForSession: async () => ({ok: true}),
    },
    requireWorkspace: async () => {},
    requireSession: async () => ({sessionSnap: {data: () => ({
      ...baseSession,
      sourceType: "github",
      sourceMode: "connected",
      sourceInstallationId: "42",
    })}}),
    requestRunnerJson: async (session, route, options) => {
      calls.push({kind: "runner", session, route, options});
      return {ok: true};
    },
  });
  assert.deepStrictEqual(await connectedService.pushGit("uid", "workspace", "session"), {ok: true});
  assert.deepStrictEqual(calls[0], {kind: "token", installationId: "42"});
  assert.deepStrictEqual(calls[1].options.body, {pushToken: "github-token", pushUsername: "x-access-token"});

  const missingAuthService = createGitSessionService({
    githubService: {createGithubInstallationToken: async () => ({token: "unused"})},
    requireWorkspace: async () => {},
    requireSession: async () => ({sessionSnap: {data: () => ({
      ...baseSession,
      sourceType: "github",
      sourceMode: "connected",
      sourceInstallationId: "not-numeric",
    })}}),
    requestRunnerJson: async () => ({ok: true}),
  });
  await assert.rejects(
      missingAuthService.pushGit("uid", "workspace", "session"),
      (error) => error.status === 503 && error.publicMessage === "github_push_auth_unavailable",
  );

  console.log("git session service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
