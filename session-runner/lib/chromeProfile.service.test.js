"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  createChromeProfileService,
  sanitizeChromeProfile,
} = require("./chromeProfile.service");

test("restores Chrome profile into a staged directory and removes transient state", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-chrome-profile-test-"));
  const profileDir = path.join(root, "profile");
  await fs.promises.mkdir(path.join(profileDir, "Default", "Cache"), {recursive: true});
  await fs.promises.writeFile(path.join(profileDir, "old-history"), "replace me");

  const archives = {
    archiveSyncTargets: [{mode: "chromeProfile", localPath: profileDir}],
    findArchiveFile: async () => ({name: "chrome-profile.tar.gz"}),
    extractStorageArchive: async (file, target) => {
      assert.equal(file.name, "chrome-profile.tar.gz");
      await fs.promises.mkdir(path.join(target.localPath, "Default", "Cache"), {recursive: true});
      await fs.promises.mkdir(path.join(target.localPath, "Default", "Downloads"), {recursive: true});
      await fs.promises.writeFile(path.join(target.localPath, "History"), "keep me");
      await fs.promises.writeFile(path.join(target.localPath, "SingletonLock"), "stale lock");
      await fs.promises.writeFile(path.join(target.localPath, "Default", "Cache", "cached"), "discard");
      await fs.promises.writeFile(path.join(target.localPath, "Default", "Downloads", "download"), "discard");
      await fs.promises.symlink("/tmp", path.join(target.localPath, "unsafe-link"));
    },
  };
  try {
    const profile = createChromeProfileService({
      config: {chromeEnabled: true, chromeProfileDir: profileDir},
      archives,
    });
    const result = await profile.restore();

    assert.deepEqual(result, {enabled: true, restored: true, sanitized: true});
    assert.equal(await fs.promises.readFile(path.join(profileDir, "History"), "utf8"), "keep me");
    await assert.rejects(fs.promises.stat(path.join(profileDir, "old-history")), {code: "ENOENT"});
    await assert.rejects(fs.promises.stat(path.join(profileDir, "SingletonLock")), {code: "ENOENT"});
    await assert.rejects(fs.promises.stat(path.join(profileDir, "Default", "Cache")), {code: "ENOENT"});
    await assert.rejects(fs.promises.stat(path.join(profileDir, "Default", "Downloads")), {code: "ENOENT"});
    await assert.rejects(fs.promises.lstat(path.join(profileDir, "unsafe-link")), {code: "ENOENT"});
    assert.equal((await fs.promises.stat(profileDir)).mode & 0o777, 0o700);
  } finally {
    await fs.promises.rm(root, {recursive: true, force: true});
  }
});

test("sanitizes an existing Chrome profile when no archive is available", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-chrome-profile-test-"));
  const profileDir = path.join(root, "profile");
  await fs.promises.mkdir(path.join(profileDir, "Default", "GPUCache"), {recursive: true});
  await fs.promises.writeFile(path.join(profileDir, "SingletonSocket"), "stale lock");
  try {
    const profile = createChromeProfileService({
      config: {chromeEnabled: true, chromeProfileDir: profileDir},
      archives: {
        archiveSyncTargets: [{mode: "chromeProfile", localPath: profileDir}],
        findArchiveFile: async () => null,
        extractStorageArchive: async () => assert.fail("archive should not be extracted"),
      },
    });

    assert.deepEqual(await profile.restore(), {enabled: true, restored: false, sanitized: true});
    await assert.rejects(fs.promises.stat(path.join(profileDir, "SingletonSocket")), {code: "ENOENT"});
    await assert.rejects(fs.promises.stat(path.join(profileDir, "Default", "GPUCache")), {code: "ENOENT"});
  } finally {
    await fs.promises.rm(root, {recursive: true, force: true});
  }
});

test("does not touch profiles for non-Chrome runners", async () => {
  let called = false;
  const profile = createChromeProfileService({
    config: {chromeEnabled: false},
    archives: {
      archiveSyncTargets: [],
      findArchiveFile: async () => {
        called = true;
        return null;
      },
    },
  });

  assert.equal(profile.enabled(), false);
  assert.deepEqual(await profile.restore(), {enabled: false, restored: false, sanitized: false});
  assert.equal(called, false);
});

test("sanitizeChromeProfile creates a private profile directory", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-chrome-profile-test-"));
  const profileDir = path.join(root, "nested", "profile");
  try {
    await sanitizeChromeProfile(profileDir);
    assert.equal((await fs.promises.stat(profileDir)).mode & 0o777, 0o700);
  } finally {
    await fs.promises.rm(root, {recursive: true, force: true});
  }
});
