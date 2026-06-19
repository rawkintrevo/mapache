"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeBranchDescription,
  normalizeGitActionPaths,
  normalizeGitBranchName,
  normalizeGitCommitMessage,
  normalizeGitPullRequestPayload,
  normalizeGitPushAuthPayload,
} = require("./gitValidation.helpers");

function assertMessage(fn, message) {
  assert.throws(fn, (error) => error && error.message === message);
}

test("normalizes git action paths and rejects internal or empty targets", () => {
  assert.deepEqual(normalizeGitActionPaths(["/src/app.js", "docs/readme.md"]), [
    "src/app.js",
    "docs/readme.md",
  ]);

  assertMessage(() => normalizeGitActionPaths([]), "missing_paths");
  assertMessage(() => normalizeGitActionPaths(["/"]), "invalid_git_path");
  assertMessage(() => normalizeGitActionPaths([".mapache-internal/log.json"]), "invalid_git_path");
  assertMessage(() => normalizeGitActionPaths([".mapahce-internal/log.json"]), "invalid_git_path");
  assertMessage(() => normalizeGitActionPaths(["src/.mapache-directory/file"]), "invalid_git_path");
  assertMessage(() => normalizeGitActionPaths(["src/.mapahce-directory/file"]), "invalid_git_path");
});

test("validates branch names used for push and pull request flows", () => {
  assert.equal(normalizeGitBranchName("/feature/demo/"), "feature/demo");
  assert.equal(normalizeGitBranchName("", {required: false}), "");

  assertMessage(() => normalizeGitBranchName("", {required: true}), "missing_git_branch");
  assertMessage(() => normalizeGitBranchName("-bad"), "invalid_git_branch");
  assertMessage(() => normalizeGitBranchName("bad branch"), "invalid_git_branch");
  assertMessage(() => normalizeGitBranchName("bad..branch"), "invalid_git_branch");
  assertMessage(() => normalizeGitBranchName("bad.lock"), "invalid_git_branch");
});

test("normalizes commit messages, branch descriptions, and auth payloads", () => {
  assert.equal(normalizeGitCommitMessage("  ship it  "), "ship it");
  assert.equal(normalizeBranchDescription(" Demo Session! "), "demo-session");
  assertMessage(() => normalizeGitCommitMessage(""), "missing_commit_message");

  assert.deepEqual(normalizeGitPushAuthPayload({
    pushUsername: "",
    pushToken: " token ",
  }), {
    pushUsername: "x-access-token",
    pushToken: "token",
  });
  assert.deepEqual(normalizeGitPullRequestPayload({
    baseBranch: "main",
    workingBranchName: "feature/work",
    pushUsername: "user",
    pushToken: "token",
  }), {
    baseBranch: "main",
    workingBranchName: "feature/work",
    pushUsername: "user",
    pushToken: "token",
  });
});
