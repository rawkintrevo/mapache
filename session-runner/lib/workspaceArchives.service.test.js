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
  createArchiveSyncTargets,
  createWorkspaceArchiveService,
  homeArchiveRemotePath,
  piMcpOAuthArchiveRemotePath,
  waitForArchiveExtraction,
} = require("./workspaceArchives.service");

function baseConfig(overrides = {}) {
  return {
    archiveStorageDir: ".mapache-internal/archives",
    bucketName: "workspace-bucket",
    homeArchiveName: "home.tar.gz",
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
    "pi-mcp-oauth",
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
    ".npm",
    ".npm/*",
    "./.npm",
    "./.npm/*",
    ".pi/agent/npm/node_modules",
    ".pi/agent/npm/node_modules/*",
    "./.pi/agent/npm/node_modules",
    "./.pi/agent/npm/node_modules/*",
    ".pi/agent/mcp-oauth",
    ".pi/agent/mcp-oauth/*",
    "./.pi/agent/mcp-oauth",
    "./.pi/agent/mcp-oauth/*",
  ]);
  assert.equal(targets.find((target) => target.name === "home").restoreOnStartup, true);
  assert.equal(targets.find((target) => target.name === "pi-mcp-oauth").localPath, "/root/.pi/agent/mcp-oauth");
  assert.equal(targets.find((target) => target.name === "pi-mcp-oauth").remotePath,
      "users/u/workspaces/w/.mapache-internal/pi-mcp-oauth/mcp-oauth.tar.gz");
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

test("private runtimes do not publish credential, Chrome, or Git archives to shared storage", () => {
  const config = baseConfig({
    chromeEnabled: true,
    chromeProfileDir: "/var/lib/mapache/runtimes/run-1/chrome/profile",
    homeDir: "/var/lib/mapache/runtimes/run-1/home",
    homeSyncMode: "ephemeral",
    isPrivateRuntime: true,
    piAgentDir: "/var/lib/mapache/runtimes/run-1/agent-state/pi",
  });
  const targets = createArchiveSyncTargets({config, git: git(true)});
  assert.equal(chromeProfileArchiveRemotePath(config), "");
  assert.equal(piMcpOAuthArchiveRemotePath(config), "");
  assert.equal(targets.some((target) => target.name === "workspace-git"), false);
  assert.equal(targets.find((target) => target.name === "chrome-profile").remotePath, "");
  assert.equal(targets.find((target) => target.name === "pi-mcp-oauth").remotePath, "");
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
    ".npm",
    ".npm/*",
    "./.npm",
    "./.npm/*",
  ]);
});

test("builds home archive path from workspace-owned home prefix", () => {
  assert.equal(homeArchiveRemotePath(baseConfig()), "users/u/workspaces/w/.mapache-internal/home/home.tar.gz");
});

test("namespaces Pi MCP OAuth archives by workspace", () => {
  const first = baseConfig({prefix: "users/u/workspaces/one"});
  const second = baseConfig({prefix: "users/u/workspaces/two"});
  assert.notEqual(piMcpOAuthArchiveRemotePath(first), piMcpOAuthArchiveRemotePath(second));
  assert.match(piMcpOAuthArchiveRemotePath(first), /users\/u\/workspaces\/one\/.mapache-internal\/pi-mcp-oauth/);
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

test("extracts a workspace Git archive at the workspace root", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-git-extract-"));
  t.after(() => fs.promises.rm(root, {recursive: true, force: true}));
  const sourceDir = path.join(root, "source");
  const workspaceDir = path.join(root, "workspace");
  await fs.promises.mkdir(path.join(sourceDir, ".git"), {recursive: true});
  await fs.promises.mkdir(workspaceDir, {recursive: true});
  await fs.promises.writeFile(path.join(sourceDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  const archive = spawnSync("tar", ["-czf", "-", "-C", sourceDir, "./.git"]);
  assert.equal(archive.status, 0, archive.stderr.toString());

  const service = createWorkspaceArchiveService({
    config: baseConfig({workspaceDir}),
    git: git(true),
    pathHelpers: {shouldIgnoreInternalWorkspacePath: () => false},
    storage: fakeStorage({}, []),
  });
  const target = service.archiveSyncTargets.find((entry) => entry.mode === "workspaceGit");
  await fs.promises.mkdir(target.localPath, {recursive: true});
  await service.extractStorageArchive({createReadStream: () => Readable.from(archive.stdout)}, target);

  assert.equal(await fs.promises.readFile(path.join(workspaceDir, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
  await assert.rejects(fs.promises.access(path.join(workspaceDir, ".git", ".git", "HEAD")));
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
