"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {sanitizeBrowserError} = require("./chromeRuntime");
const {chromeProfileArchiveExcludePatterns} = require("./workspaceArchives.service");
const {createWorkspacePathHelpers} = require("./workspacePath.helpers");

test("browser errors redact profile and DevTools arguments", () => {
  const safe = sanitizeBrowserError(
      "Chrome failed --user-data-dir=/var/lib/mapache/chrome/profile --remote-debugging-port=9222",
  );
  assert.doesNotMatch(safe, /var\/lib|profile/);
  assert.match(safe, /<redacted-argument>/);
});

test("Chrome profile archives exclude process artifacts but preserve state databases", () => {
  const excludes = chromeProfileArchiveExcludePatterns();
  assert.ok(excludes.includes("./Singleton*"));
  assert.ok(excludes.includes("./Default/Cache/*"));
  assert.ok(excludes.includes("./Default/Downloads/*"));
  assert.ok(!excludes.some((pattern) => pattern.includes("History")));
  assert.ok(!excludes.some((pattern) => pattern.includes("Cookies")));
});

test("internal Chrome archive paths stay out of workspace file APIs", () => {
  const helpers = createWorkspacePathHelpers({
    config: {workspaceSyncPolicyExclude: [], prefix: "users/u/workspaces/w"},
  });
  assert.equal(helpers.shouldIgnoreWorkspacePath(".mapache-internal/chrome/chrome-profile.tar.gz"), true);
  assert.equal(helpers.shouldManageGithubWorktreeRemotePath(
      "users/u/workspaces/w/.mapache-internal/chrome/chrome-profile.tar.gz",
  ), false);
});
