"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  isPrivateRuntimeStorageMode,
  normalizeRuntimeIdentity,
  normalizeRuntimeStorageMode,
  privateRuntimePaths,
} = require("./runtimeStorage.helpers");

test("private runtime paths are stable per run and stay outside the shared worktree", () => {
  assert.equal(normalizeRuntimeStorageMode("private"), "private");
  assert.equal(normalizeRuntimeStorageMode("unexpected"), "shared");
  assert.equal(isPrivateRuntimeStorageMode("private"), true);
  assert.equal(normalizeRuntimeIdentity("run/with secret"), "run-with-secret");

  const first = privateRuntimePaths({root: "/tmp/mapache-runtimes", identity: "run-1"});
  const second = privateRuntimePaths({root: "/tmp/mapache-runtimes", identity: "run-2"});
  for (const key of ["homeDir", "piAgentDir", "piSessionDir", "piMcpConfigPath", "piWebUiControlPath", "chromeProfileDir", "privateGitDir"]) {
    assert.notEqual(first[key], second[key], key);
    assert.equal(first[key].startsWith("/workspace"), false);
  }
  assert.equal(first.piMcpConfigPath, path.join(first.piAgentDir, "mcp.json"));
  assert.equal(first.piWebUiControlPath.startsWith(first.piWebUiDataDir), true);
  assert.equal(first.privateGitDir.endsWith("/git/repository"), true);
});

console.log("runtime storage helper tests passed");
