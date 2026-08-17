"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {Readable} = require("node:stream");
const test = require("node:test");
const {
  chromeProfileArchiveExcludePatterns,
  chromeProfileArchiveRemotePath,
  codexHomeArchiveRemotePath,
  createArchiveSyncTargets,
  createWorkspaceArchiveService,
  homeArchiveRemotePath,
  waitForArchiveExtraction,
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
    piAgentDir: "/root/.pi/agent",
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
  assert.deepEqual(targets.find((target) => target.name === "home").exclude, [
    ".config/gh/hosts.yml",
    "./.config/gh/hosts.yml",
    ".pi/agent/npm/node_modules",
    ".pi/agent/npm/node_modules/*",
    "./.pi/agent/npm/node_modules",
    "./.pi/agent/npm/node_modules/*",
  ]);
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

test("adds a Chrome-only profile archive outside normal workspace files", () => {
  const targets = createArchiveSyncTargets({
    config: baseConfig({chromeEnabled: true, chromeProfileDir: "/var/lib/mapache/chrome/profile"}),
    git: git(false),
  });
  const target = targets.find((entry) => entry.name === "chrome-profile");

  assert.ok(target);
  assert.equal(target.mode, "chromeProfile");
  assert.equal(target.localPath, "/var/lib/mapache/chrome/profile");
  assert.equal(target.remotePath, "users/u/workspaces/w/.mapache-internal/chrome/chrome-profile.tar.gz");
  assert.deepEqual(target.exclude, chromeProfileArchiveExcludePatterns());
  assert.equal(chromeProfileArchiveRemotePath(baseConfig()), "");
  assert.equal(chromeProfileArchiveRemotePath(baseConfig({chromeEnabled: true})),
      "users/u/workspaces/w/.mapache-internal/chrome/chrome-profile.tar.gz");
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

test("does not add Pi npm excludes when Pi agent dir is outside home", () => {
  const targets = createArchiveSyncTargets({
    config: baseConfig({piAgentDir: "/tmp/pi-agent"}),
    git: git(false),
  });
  const homeTarget = targets.find((target) => target.name === "home");

  assert.deepEqual(homeTarget.exclude, [
    ".config/gh/hosts.yml",
    "./.config/gh/hosts.yml",
  ]);
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

test("profile extraction reports the tar failure instead of a premature stream close", async () => {
  const streamError = new Error("Premature close");
  const tarError = new Error("extract chrome-profile failed with exit code 64: invalid option");

  await assert.rejects(
      waitForArchiveExtraction(Promise.reject(streamError), Promise.reject(tarError)),
      tarError,
  );
  await assert.rejects(
      waitForArchiveExtraction(Promise.reject(streamError), Promise.resolve()),
      streamError,
  );
});

test("extracts a Chrome profile with the runtime GNU tar", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-profile-extract-"));
  t.after(() => fs.promises.rm(root, {recursive: true, force: true}));
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "target");
  await fs.promises.mkdir(path.join(sourceDir, "Default"), {recursive: true});
  await fs.promises.mkdir(targetDir, {recursive: true});
  await fs.promises.writeFile(path.join(sourceDir, "Default", "Preferences"), "profile-ok");
  const archive = spawnSync("tar", ["-czf", "-", "-C", sourceDir, "."]);
  assert.equal(archive.status, 0, archive.stderr.toString());

  const service = createWorkspaceArchiveService({
    config: baseConfig({chromeEnabled: true, chromeProfileDir: targetDir}),
    git: git(false),
    pathHelpers: {shouldIgnoreInternalWorkspacePath: () => false},
    storage: fakeStorage({}, []),
  });
  const target = service.archiveSyncTargets.find((entry) => entry.mode === "chromeProfile");
  await service.extractStorageArchive({createReadStream: () => Readable.from(archive.stdout)}, target);

  assert.equal(await fs.promises.readFile(path.join(targetDir, "Default", "Preferences"), "utf8"), "profile-ok");
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
