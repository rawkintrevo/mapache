"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createWorkspacePathHelpers} = require("./workspacePath.helpers");

function helpers(overrides = {}) {
  return createWorkspacePathHelpers({
    config: {
      prefix: "users/u/workspaces/w",
      directoryMarkerFile: ".mapahce-directory",
      internalStorageDir: ".mapahce-internal",
      workspaceSyncPolicyExclude: ["build", "tmp"],
      ...overrides,
    },
  });
}

test("filters archive-backed and policy-excluded workspace paths", () => {
  const pathHelpers = helpers();

  assert.equal(pathHelpers.shouldIgnoreWorkspacePath("src/app.js"), false);
  assert.equal(pathHelpers.shouldIgnoreWorkspacePath("node_modules/pkg/index.js"), true);
  assert.equal(pathHelpers.shouldIgnoreWorkspacePath("packages/site/node_modules/pkg/index.js"), true);
  assert.equal(pathHelpers.shouldIgnoreWorkspacePath(".mapahce-internal/archives/root.tar.gz"), true);
  assert.equal(pathHelpers.shouldIgnoreWorkspacePath(".pi/npm/cache/pkg"), true);
  assert.equal(pathHelpers.shouldIgnoreWorkspacePath(".pi/git/repo"), true);
  assert.equal(pathHelpers.shouldIgnoreWorkspacePath("build/app.js"), true);
  assert.equal(pathHelpers.shouldIgnoreWorkspacePath("reports/tmp/cache.json"), true);
});

test("selects GitHub worktree cache objects that can be reconciled", () => {
  const pathHelpers = helpers();

  assert.equal(pathHelpers.shouldManageGithubWorktreeRemotePath("users/u/workspaces/w/src/app.js"), true);
  assert.equal(pathHelpers.shouldManageGithubWorktreeRemotePath("users/u/workspaces/w/.mapahce-directory"), false);
  assert.equal(pathHelpers.shouldManageGithubWorktreeRemotePath("users/u/workspaces/w/.mapahce-internal/archives/workspace-git.tar.gz"), false);
  assert.equal(pathHelpers.shouldManageGithubWorktreeRemotePath("users/u/workspaces/w/"), false);
  assert.equal(pathHelpers.shouldManageGithubWorktreeRemotePath(""), false);
});

test("builds normalized workspace remote paths", () => {
  const pathHelpers = helpers({prefix: "users/u/workspaces/w/"});

  assert.equal(pathHelpers.workspaceRemotePath("/src//app.js"), "users/u/workspaces/w/src/app.js");
  assert.equal(pathHelpers.normalizeRemoteWorkspacePath("users/u/workspaces/w/src/app.js"), "src/app.js");
});
