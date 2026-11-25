"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {Readable} = require("node:stream");
const test = require("node:test");
const {createDiskUploadService, normalizeUploadError, parseContentRange} = require("./diskUpload.service");

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

test("serializes concurrent chunks and rolls back malformed chunk bodies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-upload-"));
  const service = createDiskUploadService({config: {workspaceDir: root, retainedDiskPaths: {uploads: path.join(root, "uploads"), caches: path.join(root, "state")}}});
  const operation = await service.begin({operationId: "operation-3", name: "resume.bin", size: 6});
  await assert.rejects(
      service.append(operation.operationId, Readable.from([Buffer.from("abcd")]), {start: 0, end: 2, total: 6}),
      /upload_size_mismatch/,
  );
  assert.equal(await fs.stat(path.join(root, "uploads", ".operation-3.part")).then(stat => stat.size), 0);

  const results = await Promise.allSettled([
    service.append(operation.operationId, Readable.from([Buffer.from("abc")]), {start: 0, end: 2, total: 6}),
    service.append(operation.operationId, Readable.from([Buffer.from("def")]), {start: 0, end: 2, total: 6}),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected")[0].reason.message, "upload_offset_conflict");
  assert.deepEqual(await service.append(operation.operationId, Readable.from([Buffer.from("def")]), {start: 3, end: 5, total: 6}), {complete: true, offset: 6});
  assert.equal(await fs.readFile(path.join(root, "uploads", "resume.bin"), "utf8"), "abcdef");
});

test("rejects a symlinked temporary path without touching its target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-upload-"));
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "keep");
  const service = createDiskUploadService({config: {workspaceDir: root, retainedDiskPaths: {uploads: path.join(root, "uploads"), caches: path.join(root, "state")}}});
  const operation = await service.begin({operationId: "operation-4", name: "safe.bin", size: 4});
  await fs.symlink(outside, path.join(root, "uploads", ".operation-4.part"));
  await assert.rejects(
      service.append(operation.operationId, Readable.from([Buffer.from("safe")]), {start: 0, end: 3, total: 4}),
      /upload_temporary_path_invalid/,
  );
  assert.equal(await fs.readFile(outside, "utf8"), "keep");
  await assert.rejects(fs.lstat(path.join(root, "uploads", ".operation-4.part")), {code: "ENOENT"});
});

test("maps exhausted retained storage to a resumable upload error", () => {
  const error = normalizeUploadError(Object.assign(new Error("no space"), {code: "ENOSPC"}));
  assert.equal(error.publicMessage, "upload_storage_full");
  assert.equal(error.status, 507);
});
