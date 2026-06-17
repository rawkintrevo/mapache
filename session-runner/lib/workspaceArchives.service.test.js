"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createArchiveSyncTargets,
  piHomeArchiveExcludes,
} = require("./workspaceArchives.service");

function baseConfig(overrides = {}) {
  return {
    archiveStorageDir: ".mapahce-internal/archives",
    bucketName: "workspace-bucket",
    piHomeBucketName: "pi-home-bucket",
    piHomePrefix: "users/u/.mapahce-internal/pi-home",
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
    "root-pi",
    "pi-session",
  ]);
  assert.equal(targets.find((target) => target.name === "workspace-node-modules").remotePath,
      "users/u/workspaces/w/.mapahce-internal/archives/workspace-node_modules.tar.gz");
  assert.equal(targets.find((target) => target.name === "root-pi").bucketName, "pi-home-bucket");
  assert.equal(targets.find((target) => target.name === "root-pi").remotePath,
      "users/u/.mapahce-internal/pi-home/root-pi.tar.gz");
  assert.deepEqual(targets.find((target) => target.name === "root-pi").fallbackArchives, [{
    bucketName: "workspace-bucket",
    remotePath: "users/u/workspaces/w/.mapahce-internal/archives/root-pi.tar.gz",
  }]);
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

test("falls back root Pi archive path to workspace archive prefix", () => {
  const targets = createArchiveSyncTargets({
    config: baseConfig({piHomePrefix: "", piHomeBucketName: ""}),
    git: git(false),
  });
  const rootPiTarget = targets.find((target) => target.name === "root-pi");

  assert.equal(rootPiTarget.bucketName, "");
  assert.equal(rootPiTarget.remotePath,
      "users/u/workspaces/w/.mapahce-internal/archives/root-pi.tar.gz");
});

test("root Pi archive excludes session-specific conversation state", () => {
  assert.ok(piHomeArchiveExcludes().includes("agent/sessions/*"));
  assert.ok(piHomeArchiveExcludes().includes("./agent/mapache-sessions/*"));
});
