"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  prepareRetainedDisk,
  retainedDiskPaths,
} = require("./retainedDiskStorage");

test("initializes an empty retained disk and reuses it without formatting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-retained-disk-"));
  const first = await prepareRetainedDisk({root, workspaceId: "workspace-1", ownerUid: "owner-1", generation: 4});
  await fs.writeFile(path.join(first.paths.workspace, "dirty.txt"), "keep me");
  const second = await prepareRetainedDisk({root, workspaceId: "workspace-1", ownerUid: "owner-1", generation: 4});
  assert.equal(second.initialized, false);
  assert.equal(await fs.readFile(path.join(second.paths.workspace, "dirty.txt"), "utf8"), "keep me");
});

test("retained disk identity survives a VM generation replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-retained-generation-"));
  await prepareRetainedDisk({root, workspaceId: "workspace-1", ownerUid: "owner-1", generation: 1});
  const replacement = await prepareRetainedDisk({root, workspaceId: "workspace-1", ownerUid: "owner-1", generation: 2});
  assert.equal(replacement.initialized, false);
  assert.equal(replacement.marker.generation, 1);
});

test("rejects a populated disk without an identity marker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-retained-disk-"));
  await fs.writeFile(path.join(root, "user-data"), "not safe to adopt");
  await assert.rejects(
      prepareRetainedDisk({root, workspaceId: "workspace-1", ownerUid: "owner-1"}),
      (error) => error.code === "retained_disk_marker_missing",
  );
});

test("rejects a disk owned by another workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-retained-disk-"));
  await prepareRetainedDisk({root, workspaceId: "workspace-1", ownerUid: "owner-1"});
  await assert.rejects(
      prepareRetainedDisk({root, workspaceId: "workspace-2", ownerUid: "owner-1"}),
      (error) => error.code === "retained_disk_identity_mismatch",
  );
  assert.equal(retainedDiskPaths(root).workspace.endsWith("/workspace"), true);
});
