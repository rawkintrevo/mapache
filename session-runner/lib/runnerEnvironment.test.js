"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const test = require("node:test");
const {
  applyMapacheToolPath,
  createWorkspaceProcessEnvironment,
  isolateRunnerGoogleCredentials,
  prependPathEntries,
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

test("VM terminal and tool children use retained HOME and caches", () => {
  const env = createWorkspaceProcessEnvironment({
    retainedDiskMode: true,
    homeDir: "/data/home",
    retainedDiskPaths: {caches: "/data/caches"},
    workspaceDir: "/data/workspace",
    piAgentDir: "/data/agent/pi",
    userLocalBinDir: "/data/home/.local/bin",
  }, {HOME: "/root", XDG_CONFIG_HOME: "/root/.config", TMPDIR: "/old/tmp"});
  assert.equal(env.HOME, "/data/home");
  assert.equal(env.XDG_CONFIG_HOME, "/data/home/.config");
  assert.equal(env.XDG_STATE_HOME, "/data/home/.local/state");
  assert.equal(env.XDG_CACHE_HOME, "/data/caches");
  assert.equal(env.TMPDIR, "/tmp");
  assert.equal(env.WORKSPACE_DIR, "/data/workspace");
  assert.equal(env.PI_CODING_AGENT_DIR, "/data/agent/pi");
  assert.ok(env.PATH.split(":").includes("/data/home/.local/bin"));
});

test("tool PATH is deterministic, idempotent, and preserves existing system entries", () => {
  assert.equal(
      prependPathEntries("/usr/bin:/workspace/.local/bin:/usr/local/bin", ["/workspace/.local/bin", "/root/.local/bin"]),
      "/workspace/.local/bin:/root/.local/bin:/usr/bin:/usr/local/bin",
  );

  const env = {PATH: "/usr/bin:/bin"};
  applyMapacheToolPath({
    workspaceDir: "/workspace",
    workspaceLocalBinDir: "/workspace/.local/bin",
    userLocalBinDir: "/root/.local/bin",
  }, env);
  assert.equal(env.PATH, "/workspace/.local/bin:/root/.local/bin:/usr/bin:/bin");
  assert.equal(env.MAPACHE_WORKSPACE_BIN_DIR, "/workspace/.local/bin");
  assert.equal(env.MAPACHE_USER_BIN_DIR, "/root/.local/bin");
});

test("every workspace child receives both install locations", () => {
  const childEnv = createWorkspaceProcessEnvironment({
    workspaceDir: "/workspace",
    workspaceLocalBinDir: "/workspace/.local/bin",
    userLocalBinDir: "/root/.local/bin",
    workspaceGoogleApplicationCredentials: "",
  }, {PATH: "/usr/bin"});

  assert.equal(childEnv.PATH, "/workspace/.local/bin:/root/.local/bin:/usr/bin");
});

test("a fresh child resolves an executable from the workspace install directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-tool-path-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const workspaceBinDir = path.join(root, "workspace", ".local", "bin");
  await fs.mkdir(workspaceBinDir, {recursive: true});
  const executable = path.join(workspaceBinDir, "mapache-test-tool");
  await fs.writeFile(executable, "#!/bin/sh\nprintf 'tool-ok\\n'\n");
  await fs.chmod(executable, 0o755);

  const childEnv = createWorkspaceProcessEnvironment({
    workspaceDir: path.join(root, "workspace"),
    workspaceLocalBinDir: workspaceBinDir,
    userLocalBinDir: path.join(root, "user", ".local", "bin"),
    workspaceGoogleApplicationCredentials: "",
  }, {PATH: "/usr/bin:/bin"});
  const result = spawnSync("sh", ["-c", "command -v mapache-test-tool && mapache-test-tool"], {
    encoding: "utf8",
    env: childEnv,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${executable}\ntool-ok\n`);
});
