"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const test = require("node:test");
const {createGitService} = require("./git");

function git(cwd, ...args) {
  return execFileSync("git", args, {cwd, encoding: "utf8"}).trim();
}

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-git-service-"));
  const origin = path.join(root, "origin.git");
  const workspaceDir = path.join(root, "workspace");
  git(root, "init", "--bare", origin);
  fs.mkdirSync(workspaceDir);
  git(workspaceDir, "init", "-b", "main");
  git(workspaceDir, "config", "user.name", "Test User");
  git(workspaceDir, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(workspaceDir, "README.md"), "hello\n");
  git(workspaceDir, "add", ".");
  git(workspaceDir, "commit", "-m", "initial");
  git(workspaceDir, "remote", "add", "origin", origin);
  git(workspaceDir, "push", "-u", "origin", "main");
  git(workspaceDir, "checkout", "-b", "remote-only");
  fs.writeFileSync(path.join(workspaceDir, "remote.txt"), "remote\n");
  git(workspaceDir, "add", ".");
  git(workspaceDir, "commit", "-m", "remote branch");
  git(workspaceDir, "push", "-u", "origin", "remote-only");
  git(workspaceDir, "checkout", "main");
  git(workspaceDir, "branch", "-D", "remote-only");
  const service = createGitService({
    config: {workspaceDir, workspaceSourceMode: "github"},
    activity: {updateSessionActivity: async () => {}, updateWorkspaceSourceState: async () => {}},
  });
  return {root, service, workspaceDir};
}

test("lists local and remote branches, checks out remote branches, creates branches, and ignores exact paths", async () => {
  const {root, service, workspaceDir} = createHarness();
  try {
    const listed = await service.listGitBranches();
    assert.equal(listed.branches.some((branch) => branch.name === "main" && branch.local), true);
    assert.equal(listed.branches.some((branch) => branch.name === "remote-only" && branch.remote && !branch.local), true);

    await service.checkoutGitBranch({branch: "remote-only"});
    assert.equal(git(workspaceDir, "branch", "--show-current"), "remote-only");
    await service.createGitBranch({branch: "feature/new"});
    assert.equal(git(workspaceDir, "branch", "--show-current"), "feature/new");

    fs.writeFileSync(path.join(workspaceDir, "strange[1].txt"), "ignored\n");
    await service.ignoreGitPath({path: "strange[1].txt"});
    const ignore = fs.readFileSync(path.join(workspaceDir, ".gitignore"), "utf8");
    assert.match(ignore, /^\/strange\\\[1\\\]\.txt$/m);
    assert.equal(git(workspaceDir, "check-ignore", "--", "strange[1].txt"), "strange[1].txt");
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
