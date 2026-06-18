"use strict";

const assert = require("assert");
const {
  buildWorkingBranchName,
  cleanGithubApiMessage,
  cleanGithubErrorBody,
  cleanGithubNumericId,
  cleanGithubValue,
  encodeGithubContentPath,
  githubRepoMapKey,
  isConnectedGithubSourcePayload,
  normalizeBranchDescription,
  normalizeGithubConnectionStatus,
  normalizeGithubConnectedRepo,
  normalizeGithubInstallationId,
  normalizeGithubInstallationIds,
  normalizeGithubInstallationRecord,
  normalizeGithubReturnTo,
  normalizeGithubTokenPermissions,
  normalizePullRequestBody,
  normalizePullRequestTitle,
  normalizeStoredGithubRepositoryRecord,
  sessionSourceMetadata,
} = require("./github.service");

assert.strictEqual(cleanGithubValue(` ${"x".repeat(300)} `).length, 256);
assert.strictEqual(cleanGithubValue("  owner/repo  "), "owner/repo");
assert.strictEqual(cleanGithubNumericId(" 12345 "), "12345");
assert.strictEqual(cleanGithubNumericId("12x"), "");

assert.strictEqual(normalizeGithubInstallationId("123"), "123");
assert.throws(() => normalizeGithubInstallationId("abc"), /invalid_github_installation_id/);
assert.deepStrictEqual(normalizeGithubInstallationIds(["1", "bad", 2]), ["1", "2"]);

assert.strictEqual(isConnectedGithubSourcePayload({mode: "connected"}), true);
assert.strictEqual(isConnectedGithubSourcePayload({installationId: "42"}), true);
assert.strictEqual(isConnectedGithubSourcePayload({repoId: "9001"}), true);
assert.strictEqual(isConnectedGithubSourcePayload({mode: "public"}), false);

assert.deepStrictEqual(normalizeGithubTokenPermissions({
  contents: "write",
  metadata: "read",
  empty: "",
  " spaced ": " read ",
}), {
  contents: "write",
  metadata: "read",
  spaced: "read",
});
assert.deepStrictEqual(normalizeGithubTokenPermissions(null), {});
assert.deepStrictEqual(normalizeGithubTokenPermissions(["contents"]), {});

assert.deepStrictEqual(normalizeGithubInstallationRecord("uid-1", "42", {
  ownerUid: "uid-1",
  installationStatus: "active",
  githubAccountLogin: "octo-org",
  repositorySelection: "selected",
}, new Set(["42"])), {
  installationId: "42",
  githubAccountLogin: "octo-org",
  repositorySelection: "selected",
});
assert.strictEqual(normalizeGithubInstallationRecord("uid-1", "42", {ownerUid: "other"}, new Set(["42"])), null);
assert.strictEqual(normalizeGithubInstallationRecord("uid-1", "42", {installationStatus: "suspended"}, new Set(["42"])), null);
assert.strictEqual(normalizeGithubInstallationRecord("uid-1", "42", {}, new Set(["7"])), null);

assert.deepStrictEqual(normalizeGithubConnectionStatus("uid-1", {
  githubUserId: "123",
  githubLogin: "octocat",
  displayName: "Octo Cat",
  avatarUrl: "https://avatars.githubusercontent.com/u/123?v=4",
  connectionStatus: "connected",
  installationIds: ["42", "77"],
}, [
  {
    id: "42",
    data: {
      ownerUid: "uid-1",
      githubAccountLogin: "octo-org",
      githubAccountType: "Organization",
      repositorySelection: "all",
      installationStatus: "active",
    },
  },
  {
    id: "77",
    data: {
      ownerUid: "uid-1",
      githubAccountLogin: "octo-user",
      githubAccountType: "User",
      repositorySelection: "selected",
      installationStatus: "needs_reauth",
    },
  },
]), {
  connected: true,
  connectionStatus: "needs_reauth",
  githubUserId: "123",
  githubLogin: "octocat",
  displayName: "Octo Cat",
  avatarUrl: "https://avatars.githubusercontent.com/u/123?v=4",
  installationCount: 2,
  installationAccounts: [
    {
      installationId: "42",
      accountLogin: "octo-org",
      accountType: "Organization",
      repositorySelection: "all",
      status: "active",
    },
    {
      installationId: "77",
      accountLogin: "octo-user",
      accountType: "User",
      repositorySelection: "selected",
      status: "needs_reauth",
    },
  ],
});
assert.deepStrictEqual(normalizeGithubConnectionStatus("uid-1", {connectionStatus: "disconnected"}, []), {
  connected: false,
  connectionStatus: "not_connected",
  githubUserId: "",
  githubLogin: "",
  displayName: "",
  avatarUrl: "",
  installationCount: 0,
  installationAccounts: [],
});

assert.deepStrictEqual(normalizeStoredGithubRepositoryRecord("uid-1", "42", "99", {
  ownerUid: "uid-1",
  installationId: "42",
  ownerLogin: "octo-org",
  name: "mapache",
  defaultBranch: "main",
  private: true,
  cloneUrl: "https://github.com/octo-org/mapache.git",
  htmlUrl: "https://github.com/octo-org/mapache",
}), {
  repoId: "99",
  owner: "octo-org",
  name: "mapache",
  fullName: "octo-org/mapache",
  defaultBranch: "main",
  private: true,
  cloneUrl: "https://github.com/octo-org/mapache.git",
  htmlUrl: "https://github.com/octo-org/mapache",
});
assert.strictEqual(normalizeStoredGithubRepositoryRecord("uid-1", "42", "99", {ownerUid: "other"}), null);
assert.strictEqual(normalizeStoredGithubRepositoryRecord("uid-1", "42", "99", {installationId: "7"}), null);
assert.strictEqual(normalizeStoredGithubRepositoryRecord("uid-1", "42", "99", {accessible: false}), null);

assert.strictEqual(githubRepoMapKey({id: "99"}), "id:99");
assert.strictEqual(githubRepoMapKey({owner: {login: "Octo"}, name: "Mapache"}), "name:octo/mapache");
assert.strictEqual(githubRepoMapKey({full_name: "Octo/Mapache"}), "name:octo/mapache");

assert.deepStrictEqual(normalizeGithubConnectedRepo(
    {installationId: "42", githubAccountLogin: "octo-org", repositorySelection: "selected"},
    {
      id: "99",
      owner: {login: "octo-org"},
      name: "mapache",
      full_name: "octo-org/mapache",
      default_branch: "main",
      private: false,
      visibility: "public",
      clone_url: "https://github.com/octo-org/mapache.git",
      html_url: "https://github.com/octo-org/mapache",
    },
    null,
    "all",
), {
  repoId: "99",
  installationId: "42",
  owner: "octo-org",
  name: "mapache",
  fullName: "octo-org/mapache",
  defaultBranch: "main",
  private: false,
  visibility: "public",
  cloneUrl: "https://github.com/octo-org/mapache.git",
  repoUrl: "https://github.com/octo-org/mapache",
  repositorySelection: "all",
});
assert.strictEqual(normalizeGithubConnectedRepo({installationId: "42"}, {owner: {login: ""}}, null, ""), null);

assert.strictEqual(normalizeBranchDescription(" Fix: Add GitHub PR! "), "fix-add-github-pr");
assert.strictEqual(normalizeBranchDescription("x".repeat(80)).length, 48);
assert.strictEqual(buildWorkingBranchName(" Fix: Add GitHub PR! "), "mapache/fix-add-github-pr");
assert.strictEqual(buildWorkingBranchName("!!!"), "");

assert.strictEqual(normalizePullRequestTitle(` ${"t".repeat(300)} `).length, 256);
assert.strictEqual(normalizePullRequestBody(` ${"b".repeat(25000)} `).length, 20000);

assert.strictEqual(cleanGithubApiMessage({message: "Validation Failed", errors: [{field: "head"}]}), "Validation Failed: head");
assert.strictEqual(cleanGithubApiMessage({message: "Missing", errors: ["details"]}), "Missing: details");
assert.strictEqual(cleanGithubApiMessage(null), "");
assert.strictEqual(cleanGithubErrorBody(" one \n two ".repeat(80)).length, 500);

assert.strictEqual(encodeGithubContentPath("/.github/PULL REQUEST.md"), ".github/PULL%20REQUEST.md");
assert.strictEqual(normalizeGithubReturnTo("https://example.com/app?x=1"), "https://example.com/app?x=1");
assert.strictEqual(normalizeGithubReturnTo("javascript:alert(1)"), "/");
assert.strictEqual(normalizeGithubReturnTo("not a url"), "/");

assert.deepStrictEqual(sessionSourceMetadata({source: {type: "blank"}}), {sourceType: "blank"});
assert.deepStrictEqual(sessionSourceMetadata({
  source: {
    type: "github",
    mode: "connected",
    visibility: "private",
    repoUrl: "https://github.com/octo-org/mapache.git",
    owner: "octo-org",
    repo: "mapache",
    requestedBranch: "main",
    requestedCommit: "",
    resolvedBranch: "main",
    resolvedCommit: "abc123",
    connection: {
      installationId: "42",
      repoId: "99",
    },
  },
}), {
  sourceType: "github",
  sourceMode: "connected",
  sourceVisibility: "private",
  sourceRepoUrl: "https://github.com/octo-org/mapache.git",
  sourceRepoOwner: "octo-org",
  sourceRepoName: "mapache",
  sourceRequestedBranch: "main",
  sourceRequestedCommit: "",
  sourceResolvedBranch: "main",
  sourceResolvedCommit: "abc123",
  sourceInstallationId: "42",
  sourceRepoId: "99",
});

console.log("github service tests passed");
