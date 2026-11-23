"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {inventoryWorkspaceSources, importWorkspaceToRetainedDisk} = require("./vmMigration");

test("inventory accounts for workspace and HOME without mutating sources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-inventory-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(path.join(workspace, ".git"), {recursive: true});
  await fs.mkdir(home, {recursive: true});
  await fs.writeFile(path.join(workspace, "dirty.txt"), "dirty");
  await fs.writeFile(path.join(home, "history.jsonl"), "history");
  const report = await inventoryWorkspaceSources({workspaceId: "workspace-1", ownerUid: "owner-1", sourceRoot: workspace, homeRoot: home});
  assert.equal(report.readOnly, true);
  assert.equal(report.bytes, 12);
  assert.ok(report.entries.some((entry) => entry.path === "workspace/dirty.txt"));
});

test("import resumes and preserves modes, links, and dirty files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-import-"));
  const workspace = path.join(root, "source-workspace");
  const home = path.join(root, "source-home");
  const destination = path.join(root, "destination");
  await fs.mkdir(workspace, {recursive: true});
  await fs.mkdir(home, {recursive: true});
  await fs.writeFile(path.join(workspace, "README.md"), "hello");
  await fs.chmod(path.join(workspace, "README.md"), 0o750);
  await fs.symlink("README.md", path.join(workspace, "README.link"));
  await fs.writeFile(path.join(home, ".history"), "history");
  const first = await importWorkspaceToRetainedDisk({workspaceId: "workspace-1", ownerUid: "owner-1", sourceRoot: workspace, homeRoot: home, destinationRoot: destination, operationId: "import-1"});
  assert.equal(first.state, "ready");
  const second = await importWorkspaceToRetainedDisk({workspaceId: "workspace-1", ownerUid: "owner-1", sourceRoot: workspace, homeRoot: home, destinationRoot: destination, operationId: "import-1"});
  assert.equal(second.state, "ready");
  assert.equal(await fs.readFile(path.join(destination, "workspace", "README.md"), "utf8"), "hello");
  assert.equal(await fs.readlink(path.join(destination, "workspace", "README.link")), "README.md");
  assert.equal((await fs.stat(path.join(destination, "workspace", "README.md"))).mode & 0o777, 0o750);
});
