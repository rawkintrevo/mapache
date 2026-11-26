"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {initializeRemoteGuestDisk} = require("./remoteGuestDisk");
const {prepareRetainedDisk} = require("./retainedDiskStorage");

test("remote bootstrap establishes identity for the image layout and preserves it across restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-disk-"));
  const identity = {root, ownerUid: "owner-1", workspaceId: "workspace-1", generation: 1};
  try {
    await fs.mkdir(path.join(root, "home"));
    await fs.writeFile(path.join(root, "home", "sentinel"), "preserve");
    await assert.rejects(prepareRetainedDisk(identity), /retained_disk_marker_missing/);
    await initializeRemoteGuestDisk(identity);
    await prepareRetainedDisk(identity);
    const marker = path.join(root, ".mapache-vm-disk.json");
    const original = await fs.readFile(marker, "utf8");
    assert.equal((await fs.stat(marker)).mode & 0o777, 0o600);
    await initializeRemoteGuestDisk({...identity, generation: 2});
    assert.equal(await fs.readFile(marker, "utf8"), original);
    assert.equal(await fs.readFile(path.join(root, "home", "sentinel"), "utf8"), "preserve");
    await assert.rejects(initializeRemoteGuestDisk({...identity, ownerUid: "foreign"}), /retained_disk_identity_mismatch/);
    assert.equal(await fs.readFile(marker, "utf8"), original);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("remote bootstrap rejects missing identity and an unrecognized or symlinked layout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-disk-"));
  const identity = {root, ownerUid: "owner-1", workspaceId: "workspace-1"};
  try {
    await assert.rejects(initializeRemoteGuestDisk({root}), /remote_guest_identity_required/);
    await fs.symlink(os.tmpdir(), path.join(root, "home"));
    await assert.rejects(initializeRemoteGuestDisk(identity), /remote_guest_disk_unrecognized/);
    await fs.unlink(path.join(root, "home"));
    await fs.writeFile(path.join(root, "foreign"), "data");
    await assert.rejects(initializeRemoteGuestDisk(identity), /remote_guest_disk_unrecognized/);
    await assert.rejects(fs.stat(path.join(root, ".mapache-vm-disk.json")), {code: "ENOENT"});
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});
