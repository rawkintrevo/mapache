"use strict";

const assert = require("assert");
const {
  cleanGithubApiMessage,
  cleanGithubErrorBody,
  cleanGithubNumericId,
  cleanGithubValue,
  encodeGithubContentPath,
  isConnectedGithubSourcePayload,
  normalizeGithubConnectedRepo,
  normalizeGithubInstallationId,
  normalizeGithubTokenPermissions,
  sessionSourceMetadata,
} = require("./github.service");

assert.strictEqual(cleanGithubValue(` ${"x".repeat(300)} `).length, 256);
assert.strictEqual(cleanGithubValue("  owner/repo  "), "owner/repo");
assert.strictEqual(cleanGithubNumericId(" 12345 "), "12345");
assert.strictEqual(cleanGithubNumericId("12x"), "");

assert.strictEqual(normalizeGithubInstallationId("123"), "123");
assert.throws(() => normalizeGithubInstallationId("abc"), /invalid_github_installation_id/);

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

assert.strictEqual(cleanGithubApiMessage({message: "Validation Failed", errors: [{field: "head"}]}), "Validation Failed: head");
assert.strictEqual(cleanGithubApiMessage({message: "Missing", errors: ["details"]}), "Missing: details");
assert.strictEqual(cleanGithubApiMessage(null), "");
assert.strictEqual(cleanGithubErrorBody(" one \n two ".repeat(80)).length, 500);

assert.strictEqual(encodeGithubContentPath("/.github/PULL REQUEST.md"), ".github/PULL%20REQUEST.md");
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
