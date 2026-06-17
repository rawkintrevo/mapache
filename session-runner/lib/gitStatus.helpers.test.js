"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {parseGitPorcelainStatus, parseGitStatusPath} = require("./gitStatus.helpers");

test("parses porcelain branch counters and file states", () => {
  const status = parseGitPorcelainStatus([
    "## feature/demo...origin/feature/demo [ahead 2, behind 1]",
    "M  staged.js",
    " M modified.js",
    " D deleted.js",
    "?? new-file.js",
    "R  old-name.js -> renamed.js",
    "UU conflicted.js",
  ].join("\n"));

  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.equal(status.staged, 2);
  assert.equal(status.modified, 1);
  assert.equal(status.deleted, 1);
  assert.equal(status.untracked, 1);
  assert.equal(status.conflicted, 1);
  assert.deepEqual(status.files.map((file) => file.path), [
    "staged.js",
    "modified.js",
    "deleted.js",
    "new-file.js",
    "renamed.js",
    "conflicted.js",
  ]);
  assert.equal(status.files.find((file) => file.path === "new-file.js").untracked, true);
  assert.equal(status.files.find((file) => file.path === "conflicted.js").conflicted, true);
});

test("defaults branch counters when porcelain has no ahead or behind markers", () => {
  const status = parseGitPorcelainStatus("## main...origin/main\n");

  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
  assert.deepEqual(status.files, []);
});

test("normalizes rename status paths", () => {
  assert.equal(parseGitStatusPath("src/old.js -> src/new.js"), "src/new.js");
  assert.equal(parseGitStatusPath("/leading/slash.js"), "leading/slash.js");
});
