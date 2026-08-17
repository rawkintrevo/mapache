"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const TRANSIENT_PROFILE_PATHS = [
  "Crash Reports",
  "Default/Cache",
  "Default/Code Cache",
  "Default/Crashpad",
  "Default/Downloads",
  "Default/GPUCache",
  "Default/Service Worker/CacheStorage",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "DevToolsActivePort",
  "tmp",
];

function createChromeProfileService({config, archives, fsImpl = fs, osImpl = os} = {}) {
  const enabled = Boolean(config && (config.chromeEnabled || config.runnerCapabilities?.chrome));

  return {
    enabled: () => enabled,
    restore,
    sanitize: (profileDir = config && config.chromeProfileDir) => sanitizeChromeProfile(profileDir, {fsImpl}),
  };

  async function restore() {
    if (!enabled) return {enabled: false, restored: false, sanitized: false};
    const target = (archives.archiveSyncTargets || []).find((entry) => entry.mode === "chromeProfile");
    if (!target || !target.localPath) {
      throw new Error("Chrome profile archive target is not configured");
    }

    await fsImpl.promises.mkdir(path.dirname(target.localPath), {recursive: true, mode: 0o700});
    await fsImpl.promises.chmod(path.dirname(target.localPath), 0o700).catch(() => {});
    const archive = await archives.findArchiveFile(target);
    if (!archive) {
      await ensureProfileDirectory(target.localPath);
      await sanitizeChromeProfile(target.localPath, {fsImpl});
      return {enabled: true, restored: false, sanitized: true};
    }

    const stagingDir = await fsImpl.promises.mkdtemp(path.join(
        path.dirname(target.localPath),
        `.mapache-chrome-profile-${osImpl.pid || process.pid}-`,
    ));
    try {
      await archives.extractStorageArchive(archive, {
        ...target,
        localPath: stagingDir,
      });
      await sanitizeChromeProfile(stagingDir, {fsImpl});
      await replaceProfileDirectory(target.localPath, stagingDir, {fsImpl});
      return {enabled: true, restored: true, sanitized: true};
    } catch (error) {
      await removePath(stagingDir, {fsImpl});
      throw new Error(`Chrome profile restore failed: ${compactProfileError(error)}`);
    }
  }
}

async function sanitizeChromeProfile(profileDir, {fsImpl = fs} = {}) {
  if (!profileDir) return;
  await fsImpl.promises.mkdir(profileDir, {recursive: true, mode: 0o700});
  await fsImpl.promises.chmod(profileDir, 0o700).catch(() => {});

  for (const relativePath of TRANSIENT_PROFILE_PATHS) {
    await removePath(path.join(profileDir, relativePath), {fsImpl});
  }
  await removeUnsafeSymlinks(profileDir, {fsImpl});
}

async function removeUnsafeSymlinks(rootDir, {fsImpl = fs} = {}, currentDir = rootDir) {
  const entries = await fsImpl.promises.readdir(currentDir, {withFileTypes: true}).catch((error) => {
    if (error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      await removePath(entryPath, {fsImpl});
      continue;
    }
    if (entry.isDirectory()) await removeUnsafeSymlinks(rootDir, {fsImpl}, entryPath);
  }
}

async function replaceProfileDirectory(profileDir, stagingDir, {fsImpl = fs} = {}) {
  const previousDir = `${profileDir}.previous-${process.pid}`;
  await removePath(previousDir, {fsImpl});
  try {
    await fsImpl.promises.rename(profileDir, previousDir);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  try {
    await fsImpl.promises.rename(stagingDir, profileDir);
  } catch (error) {
    try {
      await fsImpl.promises.rename(previousDir, profileDir);
    } catch (restoreError) {
      error.message = `${error.message}; previous profile restore also failed`;
    }
    throw error;
  }
  await removePath(previousDir, {fsImpl});
  await fsImpl.promises.chmod(profileDir, 0o700).catch(() => {});
}

async function ensureProfileDirectory(profileDir, {fsImpl = fs} = {}) {
  await fsImpl.promises.mkdir(profileDir, {recursive: true, mode: 0o700});
  await fsImpl.promises.chmod(profileDir, 0o700).catch(() => {});
}

async function removePath(targetPath, {fsImpl = fs} = {}) {
  try {
    await fsImpl.promises.rm(targetPath, {force: true, recursive: true});
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}

function compactProfileError(error) {
  const message = String(error && (error.publicMessage || error.message) || error || "unknown error")
      .replace(/\s+/g, " ")
      .replace(/(?:\/[^\s]*)(?:profile|chrome)[^\s]*/gi, "<redacted-path>")
      .slice(0, 240);
  return message || "unknown error";
}

module.exports = {
  TRANSIENT_PROFILE_PATHS,
  compactProfileError,
  createChromeProfileService,
  removeUnsafeSymlinks,
  sanitizeChromeProfile,
};
