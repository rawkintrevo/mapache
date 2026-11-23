"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RETAINED_DISK_STORAGE_MODE = "retained-disk";
const DISK_MARKER_NAME = ".mapache-vm-disk.json";
const DISK_MARKER_VERSION = 1;

function retainedDiskPaths(root) {
  const durableRoot = path.resolve(String(root || "/var/lib/mapache/workspace"));
  return {
    root: durableRoot,
    home: path.join(durableRoot, "home"),
    workspace: path.join(durableRoot, "workspace"),
    agent: path.join(durableRoot, "agent"),
    browser: path.join(durableRoot, "browser", "profile"),
    credentials: path.join(durableRoot, "credentials"),
    uploads: path.join(durableRoot, "uploads"),
    caches: path.join(durableRoot, "caches"),
    marker: path.join(durableRoot, DISK_MARKER_NAME),
  };
}

function retainedDiskMarker({workspaceId, ownerUid, generation, operationId = null} = {}) {
  return {
    version: DISK_MARKER_VERSION,
    kind: RETAINED_DISK_STORAGE_MODE,
    workspaceId: String(workspaceId || ""),
    ownerUid: String(ownerUid || ""),
    generation: Number(generation) || 1,
    operationId: operationId ? String(operationId) : null,
  };
}

async function prepareRetainedDisk({root, workspaceId, ownerUid, generation, operationId, fsImpl = fs} = {}) {
  const paths = retainedDiskPaths(root);
  await fsImpl.promises.mkdir(paths.root, {recursive: true, mode: 0o700});
  const existing = await readMarker(paths.marker, fsImpl);
  const expected = retainedDiskMarker({workspaceId, ownerUid, generation, operationId});
  if (existing) {
    assertMarkerMatches(existing, expected);
  } else {
    const entries = await fsImpl.promises.readdir(paths.root);
    const unexpected = entries.filter((entry) => entry !== DISK_MARKER_NAME && entry !== "lost+found");
    if (unexpected.length) {
      const error = new Error("retained_disk_marker_missing");
      error.code = "retained_disk_marker_missing";
      error.entries = unexpected.slice(0, 20);
      throw error;
    }
    await writeMarker(paths.marker, expected, fsImpl);
  }
  for (const directory of [paths.home, paths.workspace, paths.agent, paths.browser, paths.credentials, paths.uploads, paths.caches]) {
    await fsImpl.promises.mkdir(directory, {recursive: true, mode: 0o700});
  }
  return {paths, marker: existing || expected, initialized: !existing};
}

async function readMarker(markerPath, fsImpl = fs) {
  try {
    const content = await fsImpl.promises.readFile(markerPath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid marker");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    const markerError = new Error("retained_disk_marker_invalid");
    markerError.code = "retained_disk_marker_invalid";
    markerError.cause = error;
    throw markerError;
  }
}

function assertMarkerMatches(actual, expected) {
  // The disk outlives VM generations. Generation is creation metadata, not
  // ownership identity, so replacement instances must be able to remount it.
  for (const field of ["version", "kind", "workspaceId", "ownerUid"]) {
    if (String(actual[field]) !== String(expected[field])) {
      const error = new Error("retained_disk_identity_mismatch");
      error.code = "retained_disk_identity_mismatch";
      error.field = field;
      throw error;
    }
  }
}

async function writeMarker(markerPath, marker, fsImpl = fs) {
  const temporary = `${markerPath}.${process.pid}.tmp`;
  await fsImpl.promises.writeFile(temporary, `${JSON.stringify(marker)}\n`, {mode: 0o600});
  await fsImpl.promises.rename(temporary, markerPath);
}

function isRetainedDiskMode(value) {
  return String(value || "").trim().toLowerCase() === RETAINED_DISK_STORAGE_MODE;
}

module.exports = {
  DISK_MARKER_NAME,
  DISK_MARKER_VERSION,
  RETAINED_DISK_STORAGE_MODE,
  assertMarkerMatches,
  isRetainedDiskMode,
  prepareRetainedDisk,
  readMarker,
  retainedDiskMarker,
  retainedDiskPaths,
};
