"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createArchiveSyncTargets,
  homeArchiveRemotePath,
} = require("./workspaceArchives.service");

function baseConfig(overrides = {}) {
  return {
    archiveStorageDir: ".mapahce-internal/archives",
    bucketName: "workspace-bucket",
    homeArchiveName: "home.tar.gz",
    homeDir: "/root",
    homeStorageBucketName: "home-bucket",
    homeStoragePrefix: "users/u/workspaces/w/.mapahce-internal/home",
    homeSyncMode: "persistent",
    piSessionDir: "/tmp/pi-session",
    piSessionStorageBucket: "session-bucket",
    piSessionStoragePrefix: "users/u/workspaces/w/.mapahce-internal/sessions/s/pi-session",
    prefix: "users/u/workspaces/w",
    workspaceDir: "/workspace",
    ...overrides,
  };
}

function git(isGithubWorkspace) {
  return {
    isGithubWorkspace: () => isGithubWorkspace,
  };
}

test("selects default archive targets for blank workspaces", () => {
  const targets = createArchiveSyncTargets({config: baseConfig(), git: git(false)});
  const names = targets.map((target) => target.name);

  assert.deepEqual(names, [
    "workspace-node-modules",
    "workspace-pi-npm",
    "workspace-pi-git",
    "home",
  ]);
  assert.equal(targets.find((target) => target.name === "workspace-node-modules").remotePath,
      "users/u/workspaces/w/.mapahce-internal/archives/workspace-node_modules.tar.gz");
  assert.equal(targets.find((target) => target.name === "home").bucketName, "home-bucket");
  assert.equal(targets.find((target) => target.name === "home").localPath, "/root");
  assert.equal(targets.find((target) => target.name === "home").remotePath,
      "users/u/workspaces/w/.mapahce-internal/home/home.tar.gz");
  assert.equal(targets.find((target) => target.name === "home").restoreOnStartup, true);
});

test("adds .git archive target only for GitHub workspaces", () => {
  const targets = createArchiveSyncTargets({config: baseConfig(), git: git(true)});
  const gitTarget = targets.find((target) => target.name === "workspace-git");

  assert.ok(gitTarget);
  assert.equal(gitTarget.mode, "workspaceGit");
  assert.equal(gitTarget.localPath, "/workspace/.git");
  assert.equal(gitTarget.remotePath,
      "users/u/workspaces/w/.mapahce-internal/archives/workspace-git.tar.gz");
});

test("disables home archive restore for ephemeral home mode", () => {
  const targets = createArchiveSyncTargets({
    config: baseConfig({homeSyncMode: "ephemeral"}),
    git: git(false),
  });
  const homeTarget = targets.find((target) => target.name === "home");

  assert.equal(homeTarget.remotePath, "");
  assert.equal(homeTarget.restoreOnStartup, false);
});

test("builds home archive path from workspace-owned home prefix", () => {
  assert.equal(homeArchiveRemotePath(baseConfig()), "users/u/workspaces/w/.mapahce-internal/home/home.tar.gz");
});
