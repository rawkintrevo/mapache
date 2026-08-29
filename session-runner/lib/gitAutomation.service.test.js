"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
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
    githubRequestedBranch: "main",
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
  assert.equal(cleanCommands.length, 1);
  assert.ok(cleanCommands.every((args) => (
    args.includes(".pi/skills/") && args.includes(".agents/skills/")
  )));
  assert.ok(harness.commands.some((args) => args[0] === "stash" && args[1] === "push"));
  assert.ok(harness.commands.some((args) => args[0] === "stash" && args[1] === "pop"));

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

test("automation resumes the current session branch without resetting restored state", async () => {
  const harness = createAutomationHarness({commitCount: 1, status: " M src/app.js"});
  const commands = [];
  const activityUpdates = [];
  const service = createGithubAutomationService({
    activity: {updateSessionActivity: async (update) => activityUpdates.push(update)},
    config: harness.config,
    runGitCommand: async (args) => {
      commands.push(args);
      if (args[0] === "branch" && args[1] === "--show-current") return "mapache/demo-session-session-1";
      if (args[0] === "ls-remote") return "main\tbase-commit";
      if (args[0] === "rev-parse") return "session-commit";
      if (args[0] === "merge-base") return "base-commit";
      return "";
    },
    withGithubAutomationAuth: (task) => task({GITHUB_AUTOMATION_TOKEN: "automation-token"}),
  });

  const result = await service.prepareGithubAutomationBranch();

  assert.equal(result.branch, "mapache/demo-session-session-1");
  assert.equal(result.baseCommit, "base-commit");
  assert.equal(commands.some((args) => args[0] === "reset"), false);
  assert.equal(commands.some((args) => args[0] === "clean"), false);
  assert.equal(commands.some((args) => args[0] === "stash"), false);
  assert.equal(activityUpdates.at(-1).githubAutomationStatus, "ready");
});

test("automation cleanup reapplies restored tracked and untracked files after branching", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-automation-restore-"));
  t.after(() => fs.promises.rm(root, {recursive: true, force: true}));
  const remoteDir = path.join(root, "remote.git");
  const seedDir = path.join(root, "seed");
  const workspaceDir = path.join(root, "workspace");
  await fs.promises.mkdir(seedDir, {recursive: true});

  runGit(root, ["init", "--bare", remoteDir]);
  runGit(seedDir, ["init", "--initial-branch=main"]);
  runGit(seedDir, ["config", "user.name", "Test User"]);
  runGit(seedDir, ["config", "user.email", "test@example.com"]);
  await fs.promises.writeFile(path.join(seedDir, "tracked.txt"), "base\n");
  runGit(seedDir, ["add", "tracked.txt"]);
  runGit(seedDir, ["commit", "-m", "base"]);
  runGit(seedDir, ["remote", "add", "origin", remoteDir]);
  runGit(seedDir, ["push", "-u", "origin", "main"]);
  runGit(root, ["clone", "--branch", "main", remoteDir, workspaceDir]);
  await fs.promises.writeFile(path.join(workspaceDir, "tracked.txt"), "restored tracked\n");
  await fs.promises.writeFile(path.join(workspaceDir, "untracked.txt"), "restored untracked\n");

  const service = createGithubAutomationService({
    activity: {updateSessionActivity: async () => {}},
    config: {
      githubAutomationToken: "token",
      githubRepoName: "repo",
      githubRepoOwner: "owner",
      githubRequestedBranch: "main",
      harnessId: "pi",
      sessionId: "session-1",
      sessionName: "Restore Test",
      workspaceSourceMode: "github",
    },
    runGitCommand: async (args) => runGit(workspaceDir, args),
    withGithubAutomationAuth: (task) => task({}),
  });

  const result = await service.prepareGithubAutomationBranch();

  assert.equal(result.branch, "mapache/restore-test-session-1");
  assert.equal(await fs.promises.readFile(path.join(workspaceDir, "tracked.txt"), "utf8"), "restored tracked\n");
  assert.equal(await fs.promises.readFile(path.join(workspaceDir, "untracked.txt"), "utf8"), "restored untracked\n");
  assert.match(runGit(workspaceDir, ["status", "--porcelain=1"]), /M tracked\.txt/);
  assert.match(runGit(workspaceDir, ["status", "--porcelain=1"]), /\?\? untracked\.txt/);
});

function runGit(cwd, args) {
  const result = spawnSync("git", args, {cwd, encoding: "utf8"});
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || "").trim();
}
