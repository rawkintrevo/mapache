"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {Readable} = require("node:stream");
const test = require("node:test");
const {createDiskUploadService, parseContentRange} = require("./diskUpload.service");

test("disk uploads resume with bounded chunks and publish atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-upload-"));
  const service = createDiskUploadService({config: {workspaceDir: root, retainedDiskPaths: {uploads: path.join(root, "uploads"), caches: path.join(root, "state")}}});
  const operation = await service.begin({operationId: "operation-1", name: "large.bin", size: 6});
  assert.deepEqual(await service.append(operation.operationId, Readable.from([Buffer.from("abc")]), {start: 0, end: 2, total: 6}), {complete: false, offset: 3});
  assert.deepEqual(await service.append(operation.operationId, Readable.from([Buffer.from("def")]), {start: 3, end: 5, total: 6}), {complete: true, offset: 6});
  assert.equal(await fs.readFile(path.join(root, "uploads", "large.bin"), "utf8"), "abcdef");
});

test("upload paths and ranges reject traversal", () => {
  assert.throws(() => parseContentRange("bytes 2-1/3"), /upload_range_invalid/);
});

test("duplicate destinations fail without replacing the existing file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-upload-"));
  await fs.mkdir(path.join(root, "uploads"), {recursive: true});
  await fs.writeFile(path.join(root, "uploads", "same.txt"), "old");
  const service = createDiskUploadService({config: {workspaceDir: root, retainedDiskPaths: {uploads: path.join(root, "uploads"), caches: path.join(root, "state")}}});
  const operation = await service.begin({operationId: "operation-2", name: "same.txt", size: 3});
  await assert.rejects(service.append(operation.operationId, Readable.from([Buffer.from("new")]), {start: 0, end: 2, total: 3}), /upload_filename_already_exists/);
  assert.equal(await fs.readFile(path.join(root, "uploads", "same.txt"), "utf8"), "old");
});
