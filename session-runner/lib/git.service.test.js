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

test("shared workspaces keep Git metadata private while Git commands use the mounted worktree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-shared-git-service-"));
  try {
    const workspaceDir = path.join(root, "workspace");
    const privateGitDir = path.join(root, "private-git");
    fs.mkdirSync(workspaceDir);
    git(root, "init", "--bare", privateGitDir);
    execFileSync("git", ["--git-dir", privateGitDir, "config", "user.name", "Test User"]);
    execFileSync("git", ["--git-dir", privateGitDir, "config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(workspaceDir, "README.md"), "shared\n");
    execFileSync("git", ["--git-dir", privateGitDir, "--work-tree", workspaceDir, "add", "README.md"]);
    execFileSync("git", ["--git-dir", privateGitDir, "--work-tree", workspaceDir, "commit", "-m", "initial"]);
    const objects = new Map();
    const storage = {
      bucket() {
        return {
          file(objectPath) {
            return {
              async exists() { return [objects.has(objectPath)]; },
              async download() { return [objects.get(objectPath)]; },
              async save(content) { objects.set(objectPath, Buffer.from(content)); },
            };
          },
        };
      },
    };
    const config = {
      bucketName: "shared-bucket",
      internalStorageDir: ".mapache-internal",
      privateGitDir,
      prefix: "workspaces/u/w",
      runtimeKind: "main",
      sessionId: "session-1",
      workspaceDir,
      workspaceSourceMode: "github",
      workspaceStorageMode: "shared-gcsfuse-v1",
    };
    const service = createGitService({
      activity: {updateSessionActivity: async () => {}, updateWorkspaceSourceState: async () => {}},
      config,
      storage,
    });

    await service.prepareSharedWorkspaceGit();
    assert.equal(fs.lstatSync(path.join(workspaceDir, ".git")).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(path.join(workspaceDir, ".git")), fs.realpathSync(privateGitDir));
    assert.equal((await service.getGitStatusSummary()).commit, git(privateGitDir, "rev-parse", "HEAD"));
    assert.equal((await service.prepareGithubAutomationBranch()), null);
    assert.equal((await service.finalizeGithubAutomationBranch(0)).skipped, true);

    const archive = await service.archiveSharedWorkspaceGit();
    assert.equal(archive.archivePath, "workspaces/u/w/.mapache-internal/shared-workspace/git/main.tar.gz");
    assert.equal(objects.has(archive.archivePath), true);

    const restoredWorkspace = path.join(root, "restored-workspace");
    const restoredPrivateGit = path.join(root, "restored-private-git");
    fs.mkdirSync(restoredWorkspace);
    const restored = createGitService({
      activity: {updateSessionActivity: async () => {}, updateWorkspaceSourceState: async () => {}},
      config: {...config, privateGitDir: restoredPrivateGit, workspaceDir: restoredWorkspace},
      storage,
    });
    await restored.prepareSharedWorkspaceGit();
    assert.equal((await restored.getGitStatusSummary()).commit, git(privateGitDir, "rev-parse", "HEAD"));
    assert.equal(fs.lstatSync(path.join(restoredWorkspace, ".git")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
