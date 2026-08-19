"use strict";

const assert = require("assert");
const {
  buildWorkingBranchName,
  createGithubPullRequestService,
  normalizeBranchDescription,
  normalizePullRequestBody,
  normalizePullRequestTitle,
} = require("./githubPullRequest.service");

assert.strictEqual(normalizeBranchDescription(" Fix: Add GitHub PR! "), "fix-add-github-pr");
assert.strictEqual(normalizeBranchDescription("x".repeat(80)).length, 48);
assert.strictEqual(buildWorkingBranchName(" Fix: Add GitHub PR! "), "mapache/fix-add-github-pr");
assert.strictEqual(buildWorkingBranchName("!!!"), "");
assert.strictEqual(normalizePullRequestTitle(` ${"t".repeat(300)} `).length, 256);
assert.strictEqual(normalizePullRequestBody(` ${"b".repeat(25000)} `).length, 20000);

(async () => {
  const calls = {};
  const service = createGithubPullRequestService({
    githubClient: {
      createGithubInstallationToken: async () => ({token: "installation-token"}),
      getGithubRepository: async () => ({default_branch: "main"}),
      getGithubPullRequestTemplate: async () => ({body: "template body", source: "repository_template:test.md"}),
      createGithubPullRequest: async (payload) => {
        calls.pullRequest = payload;
        return {
          number: 7,
          html_url: "https://github.com/octo-org/mapache/pull/7",
          title: "Open PR",
          draft: true,
          head: {ref: "mapache/fix-github-pr"},
          base: {ref: "main"},
        };
      },
    },
  });
  const session = {
    sourceType: "github",
    sourceMode: "connected",
    sourceInstallationId: "42",
    sourceRepoOwner: "octo-org",
    sourceRepoName: "mapache",
    serviceUrl: "https://runner",
    shutdownToken: "shutdown-token",
  };
  const result = await service.openPullRequestForSession(session, {
    branchDescription: "Fix GitHub PR",
    title: "Add the PR",
    draft: true,
  }, async (runnerSession, payload) => {
    calls.runner = {runnerSession, payload};
    return {pullRequest: {branch: "mapache/fix-github-pr", defaultTitle: "Fallback title"}};
  });

  assert.deepStrictEqual(calls.runner.payload, {
    baseBranch: "main",
    workingBranchName: "mapache/fix-github-pr",
    pushToken: "installation-token",
    pushUsername: "x-access-token",
  });
  assert.deepStrictEqual(calls.pullRequest, {
    owner: "octo-org",
    repo: "mapache",
    token: "installation-token",
    title: "Add the PR",
    body: "template body",
    head: "mapache/fix-github-pr",
    base: "main",
    draft: true,
  });
  assert.deepStrictEqual(result.pullRequest, {
    number: 7,
    url: "https://github.com/octo-org/mapache/pull/7",
    title: "Open PR",
    draft: true,
    head: "mapache/fix-github-pr",
    base: "main",
    bodySource: "repository_template:test.md",
  });
  assert.strictEqual(result.action, "open_pr");
  console.log("github pull request service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
