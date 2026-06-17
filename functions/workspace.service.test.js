"use strict";

const assert = require("assert");
const {
  isHiddenWorkspaceFilePath,
  normalizePublicGitHubRepoUrl,
  normalizeWorkspaceFilePath,
  normalizeWorkspaceSyncPolicy,
  parsePublicGitHubRepoUrl,
  storageFileToClientFile,
} = require("./workspace.service");

assert.strictEqual(normalizePublicGitHubRepoUrl(123), "123");
assert.throws(() => normalizePublicGitHubRepoUrl({}), /missing_github_repo_url/);

assert.deepStrictEqual(parsePublicGitHubRepoUrl("https://github.com/rawkintrevo/mapache"), {
  owner: "rawkintrevo",
  repo: "mapache",
  cloneUrl: "https://github.com/rawkintrevo/mapache.git",
});
assert.deepStrictEqual(parsePublicGitHubRepoUrl("https://www.github.com/rawkintrevo/mapache.git"), {
  owner: "rawkintrevo",
  repo: "mapache",
  cloneUrl: "https://github.com/rawkintrevo/mapache.git",
});
assert.throws(() => parsePublicGitHubRepoUrl("http://github.com/rawkintrevo/mapache"), /github_repo_url_must_use_https/);
assert.throws(() => parsePublicGitHubRepoUrl("https://github.com/rawkintrevo/mapache?tab=readme"), /invalid_github_repo_url/);
assert.throws(() => parsePublicGitHubRepoUrl("https://example.com/rawkintrevo/mapache"), /unsupported_github_repo_host/);

assert.deepStrictEqual(normalizeWorkspaceSyncPolicy({type: "blank"}), {
  mode: "blank",
  exclude: [],
});
assert.deepStrictEqual(normalizeWorkspaceSyncPolicy({type: "github"}), {
  mode: "github-cache",
  exclude: [
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    ".next/",
    ".mapahce-internal/",
  ],
});

assert.strictEqual(normalizeWorkspaceFilePath("/src/App.jsx"), "src/App.jsx");
assert.throws(() => normalizeWorkspaceFilePath("../secret"), /invalid_file_path/);
assert.throws(() => normalizeWorkspaceFilePath(".mapahce-directory"), /invalid_file_path/);
assert.throws(() => normalizeWorkspaceFilePath(".pi/npm/package.json"), /invalid_file_path/);

assert.strictEqual(isHiddenWorkspaceFilePath(".mapahce-internal/archives/x"), true);
assert.strictEqual(isHiddenWorkspaceFilePath(".pi/git/repo"), true);
assert.strictEqual(isHiddenWorkspaceFilePath(".pi/skills/demo/SKILL.md"), false);

assert.deepStrictEqual(storageFileToClientFile({
  name: "workspaces/u/w/src/App.jsx",
  metadata: {size: "123", updated: "2026-06-17T00:00:00.000Z"},
}, "workspaces/u/w/"), {
  path: "src/App.jsx",
  name: "App.jsx",
  type: "file",
  size: 123,
  updatedAt: "2026-06-17T00:00:00.000Z",
});
assert.deepStrictEqual(storageFileToClientFile({
  name: "workspaces/u/w/src/.mapahce-directory",
  metadata: {},
}, "workspaces/u/w/"), {
  path: "src",
  name: "src",
  type: "directory",
  size: 0,
  updatedAt: "",
});
assert.strictEqual(storageFileToClientFile({
  name: "workspaces/u/w/.mapahce-internal/archives/x",
  metadata: {},
}, "workspaces/u/w/"), null);

console.log("workspace service tests passed");
