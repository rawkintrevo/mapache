"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createWorkspaceProcessEnvironment,
  isolateRunnerGoogleCredentials,
} = require("./runnerEnvironment");

test("runner control plane ignores workspace Google credentials", () => {
  const env = {
    FIREBASE_PROJECT_ID: "test-project",
    GOOGLE_APPLICATION_CREDENTIALS: "/workspace/.gcloud/account.json",
  };

  const isolated = isolateRunnerGoogleCredentials(env);

  assert.deepEqual(isolated, {
    workspaceGoogleApplicationCredentials: "/workspace/.gcloud/account.json",
  });
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.FIREBASE_PROJECT_ID, "test-project");
});

test("workspace child environment receives the preserved credential path", () => {
  const baseEnv = {FIREBASE_PROJECT_ID: "test-project"};
  const childEnv = createWorkspaceProcessEnvironment({
    workspaceGoogleApplicationCredentials: "/workspace/.gcloud/account.json",
  }, baseEnv);

  assert.equal(childEnv.GOOGLE_APPLICATION_CREDENTIALS, "/workspace/.gcloud/account.json");
  assert.equal(baseEnv.GOOGLE_APPLICATION_CREDENTIALS, undefined);
});

test("private runtime child environment moves HOME and XDG state out of the worktree", () => {
  const childEnv = createWorkspaceProcessEnvironment({
    isPrivateRuntime: true,
    homeDir: "/var/lib/mapache/runtimes/run-1/home",
    privateRuntimeRoot: "/var/lib/mapache/runtimes/run-1",
    workspaceGoogleApplicationCredentials: "",
  }, {HOME: "/root", XDG_CONFIG_HOME: "/root/.config"});

  assert.equal(childEnv.HOME, "/var/lib/mapache/runtimes/run-1/home");
  assert.equal(childEnv.MAPACHE_HOME_DIR, childEnv.HOME);
  assert.equal(childEnv.XDG_CONFIG_HOME, "/var/lib/mapache/runtimes/run-1/home/.config");
  assert.equal(childEnv.XDG_CACHE_HOME, "/var/lib/mapache/runtimes/run-1/cache");
  assert.equal(childEnv.XDG_STATE_HOME, "/var/lib/mapache/runtimes/run-1/state");
  assert.equal(childEnv.TMPDIR, "/var/lib/mapache/runtimes/run-1/tmp");
});

test("shared worktree child environment exposes private Git metadata consistently", () => {
  const childEnv = createWorkspaceProcessEnvironment({
    isPrivateRuntime: true,
    homeDir: "/var/lib/mapache/runtimes/session-1/home",
    privateGitDir: "/var/lib/mapache/git/repository",
    privateRuntimeRoot: "/var/lib/mapache/runtimes/session-1",
    workspaceDir: "/workspace",
    workspaceStorageMode: "shared-gcsfuse-v1",
    workspaceGoogleApplicationCredentials: "",
  }, {});

  assert.equal(childEnv.GIT_DIR, "/var/lib/mapache/git/repository");
  assert.equal(childEnv.GIT_WORK_TREE, "/workspace");
});
