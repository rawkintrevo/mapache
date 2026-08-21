"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createGithubAutomationService} = require("./gitAutomation.service");

function createAutomationHarness({commitCount, status}) {
  const commands = [];
  const activityUpdates = [];
  const pullRequests = [];
  const config = {
    githubAutomationToken: "automation-token",
    githubRepoName: "mapache",
    githubRepoOwner: "rawkintrevo",
    harnessId: "pi",
    sessionId: "session-1",
    sessionName: "Demo Session",
    workspaceSourceMode: "github",
  };
  const runGitCommand = async (args) => {
    commands.push(args);
    if (args[0] === "branch" && args[1] === "--show-current") return "main";
    if (args[0] === "ls-remote") return args[3] === "main" ? "main\tbase-commit" : "";
    if (args[0] === "rev-parse") return "base-commit";
    if (args[0] === "status") return status;
    if (args[0] === "rev-list") return String(commitCount);
    if (args[0] === "log") return "Implement feature";
    return "";
  };
  const service = createGithubAutomationService({
    activity: {
      updateSessionActivity: async (update) => activityUpdates.push(update),
    },
    buildAutomationCommitMessage: () => "Mapache changes for Demo Session",
    buildAutomationPullRequestBody: () => "automation body",
    config,
    createGithubAutomationPullRequest: async (payload) => {
      pullRequests.push(payload);
      return {html_url: "https://github.com/rawkintrevo/mapache/pull/7", number: 7};
    },
    runGitCommand,
    withGithubAutomationAuth: (task) => task({GITHUB_AUTOMATION_TOKEN: "automation-token"}),
  });
  return {activityUpdates, commands, config, pullRequests, service};
}

test("automation commits changed files before opening a pull request", async () => {
  const harness = createAutomationHarness({commitCount: 1, status: " M src/app.js"});
  await harness.service.prepareGithubAutomationBranch();

  const cleanCommands = harness.commands.filter((args) => args[0] === "clean");
  assert.equal(cleanCommands.length, 2);
  assert.ok(cleanCommands.every((args) => (
    args.includes(".pi/skills/") && args.includes(".agents/skills/")
  )));

  const result = await harness.service.finalizeGithubAutomationBranch(0);

  assert.equal(result.pullRequest.number, 7);
  assert.ok(harness.commands.some((args) => args[0] === "commit"));
  assert.ok(harness.commands.some((args) => args[0] === "push"));
  assert.equal(harness.pullRequests[0].title, "Implement feature");
  assert.equal(harness.pullRequests[0].body, "automation body");
  assert.equal(harness.activityUpdates.at(-1).githubAutomationStatus, "pull_request_opened");
});

test("automation skips commit and pull request when there are no changes", async () => {
  const harness = createAutomationHarness({commitCount: 0, status: ""});
  await harness.service.prepareGithubAutomationBranch();

  const result = await harness.service.finalizeGithubAutomationBranch(0);

  assert.deepEqual(result, {ok: true, skipped: true, reason: "no_changes"});
  assert.equal(harness.commands.some((args) => args[0] === "commit"), false);
  assert.equal(harness.commands.some((args) => args[0] === "push"), false);
  assert.equal(harness.pullRequests.length, 0);
  assert.equal(harness.activityUpdates.at(-1).githubAutomationStatus, "no_changes");
});

test("automation pushes existing commits without creating an extra commit", async () => {
  const harness = createAutomationHarness({commitCount: 2, status: ""});
  await harness.service.prepareGithubAutomationBranch();

  const result = await harness.service.finalizeGithubAutomationBranch(0);

  assert.equal(result.pullRequest.number, 7);
  assert.equal(harness.commands.some((args) => args[0] === "commit"), false);
  assert.equal(harness.commands.some((args) => args[0] === "push"), true);
  assert.equal(harness.pullRequests.length, 1);
});
