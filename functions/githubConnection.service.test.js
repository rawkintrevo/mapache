"use strict";

const assert = require("assert");
const {
  normalizeGithubConnectionStatus,
  normalizeGithubInstallationIds,
  normalizeGithubInstallationRecord,
  normalizeGithubReturnTo,
} = require("./githubConnection.service");

assert.deepStrictEqual(normalizeGithubInstallationIds(["1", "bad", 2]), ["1", "2"]);
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

assert.strictEqual(normalizeGithubReturnTo("https://example.com/app?x=1"), "https://example.com/app?x=1");
assert.strictEqual(normalizeGithubReturnTo("javascript:alert(1)"), "/");
assert.strictEqual(normalizeGithubReturnTo("not a url"), "/");

console.log("github connection service tests passed");
