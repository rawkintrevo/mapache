"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {assertMarkerMatches, readMarker, retainedDiskMarker, retainedDiskPaths} = require("./retainedDiskStorage");

// The host-created disk and root-owned NoCloud configuration establish the
// initial identity. Generic retained-disk mounting must still reject unmarked
// nonempty volumes; only this remote guest bootstrap accepts the image layout.
async function initializeRemoteGuestDisk({root, ownerUid, workspaceId, generation, operationId}) {
  if (!ownerUid || !workspaceId) throw new Error("remote_guest_identity_required");
  const paths = retainedDiskPaths(root);
  const expected = retainedDiskMarker({ownerUid, workspaceId, generation, operationId});
  const existing = await readMarker(paths.marker, require("node:fs"));
  if (existing) {
    assertMarkerMatches(existing, expected);
    return;
  }
  const allowed = new Set(["home", "workspace", "agent", "browser", "credentials", "uploads", "caches", "lost+found"]);
  await fs.mkdir(paths.root, {recursive: true, mode: 0o700});
  for (const entry of await fs.readdir(paths.root, {withFileTypes: true})) {
    if (!allowed.has(entry.name) || !entry.isDirectory() || path.basename(entry.name) !== entry.name) {
      throw new Error("remote_guest_disk_unrecognized");
    }
  }
  // Exclusive creation cannot replace an existing identity or symlink.
  try {
    await fs.writeFile(paths.marker, JSON.stringify(expected) + "\n", {flag: "wx", mode: 0o600});
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    assertMarkerMatches(await readMarker(paths.marker, require("node:fs")), expected);
  }
}

module.exports = {initializeRemoteGuestDisk};
