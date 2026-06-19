"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  codexHomeArchiveRemotePath,
  createArchiveSyncTargets,
  createWorkspaceArchiveService,
  homeArchiveRemotePath,
} = require("./workspaceArchives.service");

function baseConfig(overrides = {}) {
  return {
    archiveStorageDir: ".mapache-internal/archives",
    bucketName: "workspace-bucket",
    homeArchiveName: "home.tar.gz",
    codexHomeDir: "/tmp/codex-home/session-1",
    codexHomeStorageBucketName: "codex-bucket",
    codexHomeStoragePrefix: "users/u/workspaces/w/.mapache-internal/codex-home",
    homeDir: "/root",
    homeStorageBucketName: "home-bucket",
    homeStoragePrefix: "users/u/workspaces/w/.mapache-internal/home",
    homeSyncMode: "persistent",
    internalStorageDir: ".mapache-internal",
    legacyArchiveStorageDirs: [".mapahce-internal/archives"],
    legacyInternalStorageDirs: [".mapahce-internal"],
    piSessionDir: "/tmp/pi-session",
    piSessionStorageBucket: "session-bucket",
    piSessionStoragePrefix: "users/u/workspaces/w/.mapache-internal/sessions/s/pi-session",
    prefix: "users/u/workspaces/w",
    workspaceDir: "/workspace",
    ...overrides,
  };
}

function git(isGithubWorkspace) {
  return {
    isGithubWorkspace: () => isGithubWorkspace,
  };
}

test("selects default archive targets for blank workspaces", () => {
  const targets = createArchiveSyncTargets({config: baseConfig(), git: git(false)});
  const names = targets.map((target) => target.name);

  assert.deepEqual(names, [
    "workspace-node-modules",
    "workspace-pi-npm",
    "workspace-pi-git",
    "home",
    "codex-home",
  ]);
  assert.equal(targets.find((target) => target.name === "workspace-node-modules").remotePath,
      "users/u/workspaces/w/.mapache-internal/archives/workspace-node_modules.tar.gz");
  assert.deepEqual(targets.find((target) => target.name === "workspace-node-modules").fallbackArchives, [{
    bucketName: "workspace-bucket",
    remotePath: "users/u/workspaces/w/.mapahce-internal/archives/workspace-node_modules.tar.gz",
  }]);
  assert.equal(targets.find((target) => target.name === "home").bucketName, "home-bucket");
  assert.equal(targets.find((target) => target.name === "home").localPath, "/root");
  assert.equal(targets.find((target) => target.name === "home").remotePath,
      "users/u/workspaces/w/.mapache-internal/home/home.tar.gz");
  assert.deepEqual(targets.find((target) => target.name === "home").fallbackArchives, [{
    bucketName: "home-bucket",
    remotePath: "users/u/workspaces/w/.mapahce-internal/home/home.tar.gz",
  }]);
  assert.equal(targets.find((target) => target.name === "home").restoreOnStartup, true);
  assert.equal(targets.find((target) => target.name === "codex-home").localPath, "/tmp/codex-home/session-1");
  assert.equal(targets.find((target) => target.name === "codex-home").bucketName, "codex-bucket");
  assert.equal(targets.find((target) => target.name === "codex-home").remotePath,
      "users/u/workspaces/w/.mapache-internal/codex-home/codex-home.tar.gz");
  assert.deepEqual(targets.find((target) => target.name === "codex-home").fallbackArchives, [{
    bucketName: "codex-bucket",
    remotePath: "users/u/workspaces/w/.mapahce-internal/codex-home/codex-home.tar.gz",
  }]);
  assert.deepEqual(targets.find((target) => target.name === "codex-home").fallbackArchivePrefixes, [
    "users/u/workspaces/w/.mapache-internal/sessions/",
    "users/u/workspaces/w/.mapahce-internal/sessions/",
  ]);
  assert.equal(targets.find((target) => target.name === "codex-home").restoreOnStartup, true);
});

test("adds .git archive target only for GitHub workspaces", () => {
  const targets = createArchiveSyncTargets({config: baseConfig(), git: git(true)});
  const gitTarget = targets.find((target) => target.name === "workspace-git");

  assert.ok(gitTarget);
  assert.equal(gitTarget.mode, "workspaceGit");
  assert.equal(gitTarget.localPath, "/workspace/.git");
  assert.equal(gitTarget.remotePath,
      "users/u/workspaces/w/.mapache-internal/archives/workspace-git.tar.gz");
});

test("disables home archive restore for ephemeral home mode", () => {
  const targets = createArchiveSyncTargets({
    config: baseConfig({homeSyncMode: "ephemeral"}),
    git: git(false),
  });
  const homeTarget = targets.find((target) => target.name === "home");

  assert.equal(homeTarget.remotePath, "");
  assert.equal(homeTarget.restoreOnStartup, false);
});

test("builds home archive path from workspace-owned home prefix", () => {
  assert.equal(homeArchiveRemotePath(baseConfig()), "users/u/workspaces/w/.mapache-internal/home/home.tar.gz");
});

test("builds codex home archive path from workspace-owned codex prefix", () => {
  assert.equal(codexHomeArchiveRemotePath(baseConfig()),
      "users/u/workspaces/w/.mapache-internal/codex-home/codex-home.tar.gz");
});

test("finds latest historical per-session codex archive as migration fallback", async () => {
  const config = baseConfig();
  const oldArchive = fakeFile(
      "users/u/workspaces/w/.mapache-internal/sessions/old/codex-home/codex-home.tar.gz",
      "2026-06-01T00:00:00.000Z",
  );
  const latestArchive = fakeFile(
      "users/u/workspaces/w/.mapache-internal/sessions/latest/codex-home/codex-home.tar.gz",
      "2026-06-02T00:00:00.000Z",
  );
  const unrelatedArchive = fakeFile(
      "users/u/workspaces/w/.mapache-internal/sessions/latest/pi-session/pi-session.tar.gz",
      "2026-06-03T00:00:00.000Z",
  );
  const storage = fakeStorage({
    "users/u/workspaces/w/.mapache-internal/codex-home/codex-home.tar.gz": fakeFile(
        "users/u/workspaces/w/.mapache-internal/codex-home/codex-home.tar.gz",
        "2026-06-03T00:00:00.000Z",
        {exists: false},
    ),
    "users/u/workspaces/w/.mapahce-internal/codex-home/codex-home.tar.gz": fakeFile(
        "users/u/workspaces/w/.mapahce-internal/codex-home/codex-home.tar.gz",
        "2026-06-03T00:00:00.000Z",
        {exists: false},
    ),
  }, [oldArchive, latestArchive, unrelatedArchive]);
  const archives = createWorkspaceArchiveService({
    config,
    git: git(false),
    pathHelpers: {shouldIgnoreInternalWorkspacePath: () => false},
    storage,
  });

  const target = archives.archiveSyncTargets.find((target) => target.name === "codex-home");
  assert.equal(await archives.findArchiveFile(target), latestArchive);
});

function fakeFile(name, updated, options = {}) {
  return {
    name,
    exists: async () => [Boolean(options.exists)],
    getMetadata: async () => [{updated}],
  };
}

function fakeStorage(filesByName, listedFiles) {
  return {
    bucket: () => ({
      file: (name) => filesByName[name] || fakeFile(name, "", {exists: false}),
      getFiles: async ({prefix}) => [listedFiles.filter((file) => file.name.startsWith(prefix))],
    }),
  };
}
