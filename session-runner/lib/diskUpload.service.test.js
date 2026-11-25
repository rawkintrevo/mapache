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

  const probeResponse = {};
  await service.handle({
    method: "PUT",
    params: {operationId: operation.operationId},
    query: {name: "large.bin", size: "6"},
    get: () => "bytes */6",
  }, {json: body => { probeResponse.body = body; }});
  assert.deepEqual(probeResponse.body, {ok: true, path: "/uploads/large.bin"});
});

test("recovers a publish interrupted after the destination rename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-upload-"));
  const uploads = path.join(root, "uploads");
  const state = path.join(root, "state");
  const service = createDiskUploadService({config: {workspaceDir: root, retainedDiskPaths: {uploads, caches: state}}});
  const operation = await service.begin({operationId: "operation-publish", name: "recovered.bin", size: 6});
  await fs.writeFile(path.join(uploads, ".operation-publish.part"), "abcdef");
  await fs.rename(path.join(uploads, ".operation-publish.part"), path.join(uploads, "recovered.bin"));
  await fs.writeFile(path.join(state, "operation-publish.json"), `${JSON.stringify({...operation, state: "publishing", digest: ""})}\n`);

  const response = {};
  await service.handle({method: "PUT", params: {operationId: operation.operationId}, query: {name: "recovered.bin", size: "6"}, get: () => "bytes */6"}, {
    json: body => { response.body = body; },
  });
  assert.deepEqual(response.body, {ok: true, path: "/uploads/recovered.bin"});
  assert.equal(JSON.parse(await fs.readFile(path.join(state, "operation-publish.json"))).state, "committed");
});

test("finishes a publish interrupted before the destination rename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-upload-"));
  const uploads = path.join(root, "uploads");
  const state = path.join(root, "state");
  const service = createDiskUploadService({config: {workspaceDir: root, retainedDiskPaths: {uploads, caches: state}}});
  const operation = await service.begin({operationId: "operation-publish2", name: "recovered.bin", size: 6});
  await fs.writeFile(path.join(uploads, ".operation-publish2.part"), "abcdef");
  await fs.writeFile(path.join(state, "operation-publish2.json"), `${JSON.stringify({...operation, state: "publishing", digest: ""})}\n`);

  const response = {};
  await service.handle({method: "PUT", params: {operationId: operation.operationId}, query: {name: "recovered.bin", size: "6"}, get: () => "bytes */6"}, {
    json: body => { response.body = body; },
  });
  assert.deepEqual(response.body, {ok: true, path: "/uploads/recovered.bin"});
  assert.equal(await fs.readFile(path.join(uploads, "recovered.bin"), "utf8"), "abcdef");
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

test("maps operation-state ENOSPC to the resumable storage-full response", async () => {
  const noSpace = Object.assign(new Error("no space"), {code: "ENOSPC"});
  const fsImpl = {
    promises: {
      ...fs,
      writeFile: async () => { throw noSpace; },
    },
  };
  const service = createDiskUploadService({
    config: {workspaceDir: "/tmp/mapache-upload-enospc", retainedDiskPaths: {uploads: "/tmp/mapache-upload-enospc/uploads", caches: "/tmp/mapache-upload-enospc/state"}},
    fsImpl,
  });
  const response = {};
  await service.handle({method: "PUT", params: {operationId: "operation-enospc"},
    query: {name: "full.bin", size: "4"}, get: () => "bytes 0-3/4"}, {
    status(code) { response.status = code; return this; },
    json(body) { response.body = body; },
  });
  assert.equal(response.status, 507);
  assert.deepEqual(response.body, {error: "upload_storage_full"});
});
