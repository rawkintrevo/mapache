"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {Readable, Writable} = require("node:stream");
const {DEFAULT_THRESHOLD, encodePointer, parsePointer, shouldDefer, publishLargeFile} = require("./workspaceLargeFiles");
const {pullLargeFile} = require("./workspaceLargeFilePull");
const {agentSnapshotStoragePrefix} = require("./agentSnapshot.service");

function descriptor(content) { return {byteLength: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex")}; }

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "large-files-"));
  t.after(() => fs.promises.rm(root, {recursive: true, force: true}));
  const config = {workspaceDir: path.join(root, "workspace"), workspaceId: "w", sessionId: "s",
    prefix: "workspaces/u/w", internalStorageDir: ".mapache-internal", bucketName: "b"};
  await fs.promises.mkdir(config.workspaceDir);
  const namespace = agentSnapshotStoragePrefix(config);
  const content = Buffer.from("model data here");
  const entry = {path: "model.pt", kind: "workspace-file", mode: 0o640, ...descriptor(content)};
  const manifest = {manifestVersion: 1, kind: "mapache-workspace-file-state", storagePrefix: namespace,
    workspaceId: "w", sessionId: "s", files: [entry]};
  const body = Buffer.from(JSON.stringify(manifest));
  const pointer = {generation: 1, bootInstanceId: "boot", captureId: "capture",
    manifest: {bucketName: "b", objectPath: `${namespace}/workspace-files/1/boot/capture/manifest.json`, ...descriptor(body)}};
  const sourcePath = `${namespace}/workspace-files/1/boot/capture/objects/model.pt`;
  const objects = new Map([[sourcePath, {content}], [pointer.manifest.objectPath, {content: body}]]);
  let downloads = 0;
  const bucket = {file(name) {
    return {name,
      async getMetadata() { const v = objects.get(name); if (!v) throw new Error("missing"); return [{size: v.content.length, generation: "1", metadata: v.metadata || {}}]; },
      async download() { downloads++; return [objects.get(name).content]; },
      createReadStream() { return Readable.from([objects.get(name).content]); },
      createWriteStream() { const chunks = []; return new Writable({write(chunk, _enc, cb) { chunks.push(chunk); cb(); }, final(cb) { objects.set(name, {content: Buffer.concat(chunks)}); cb(); }}); },
      async copy(target, options) { if (objects.has(target.name)) throw Object.assign(new Error("exists"), {code: 412}); objects.set(target.name, {content: objects.get(name).content, metadata: options.metadata}); },
      async delete() { objects.delete(name); },
    };
  }};
  const storage = {bucket(name) { assert.equal(name, "b"); return bucket; }};
  const db = {collection() { return {doc() { return {async get() { return {data: () => ({agentRuntimeWorkspaceFiles: pointer})}; }}; }}; }};
  const localPath = path.join(config.workspaceDir, "model.pt");
  await fs.promises.writeFile(localPath, encodePointer(entry));
  return {config, namespace, content, entry, manifest, pointer, sourcePath, objects, storage, db, localPath, downloads: () => downloads};
}

test("100 MiB boundary and pointers are strict and contain no remote location", () => {
  assert.equal(shouldDefer({byteLength: DEFAULT_THRESHOLD}), false);
  assert.equal(shouldDefer({byteLength: DEFAULT_THRESHOLD + 1}), true);
  const d = descriptor(Buffer.from("test"));
  assert.deepEqual(parsePointer(encodePointer(d)), d);
  assert.throws(() => parsePointer(Buffer.from("mapache-large-file-v1\ninvalid")), /invalid/);
  assert.equal(parsePointer(Buffer.from("ordinary file")), null);
});

test("legacy pointers promote by server copy, survive rename, and deduplicate without downloads", async (t) => {
  const f = await fixture(t);
  const args = {config: f.config, pointer: f.entry, previousManifest: f.manifest, previousPointer: f.pointer,
    mode: 0o640, relativePath: "renamed.pt", storage: f.storage};
  const saved = await publishLargeFile(args);
  assert.equal(saved.path, "renamed.pt");
  assert.equal(saved.storage, "large-file-v1");
  assert.deepEqual(f.objects.get(saved.objectPath).content, f.content);
  assert.deepEqual(await publishLargeFile(args), saved);
  assert.equal(f.downloads(), 0);
  assert.ok(f.objects.has(f.sourcePath), "original is retained");
  await assert.rejects(publishLargeFile({...args, pointer: descriptor(Buffer.from("forged"))}), /unrecognized/);
});

test("new large files upload through bounded streams and use content addressing", async (t) => {
  const f = await fixture(t);
  await fs.promises.writeFile(f.localPath, f.content);
  const saved = await publishLargeFile({config: f.config, localPath: f.localPath,
    mode: 0o640, relativePath: "model.pt", storage: f.storage,
    fsImpl: {...fs, promises: {...fs.promises, readFile() { assert.fail("must not buffer the file"); }}}});
  assert.equal(saved.sha256, f.entry.sha256);
  assert.deepEqual(f.objects.get(saved.objectPath).content, f.content);
  assert.equal([...f.objects.keys()].some((key) => key.includes("/staging/")), false);
});

test("pull verifies checksum and atomically replaces pointer, including renamed pointers", async (t) => {
  const f = await fixture(t);
  const renamed = path.join(f.config.workspaceDir, "renamed.pt");
  await fs.promises.rename(f.localPath, renamed);
  await pullLargeFile({...f, requestedPath: renamed, memoryAvailable: async () => 1024 ** 3});
  assert.deepEqual(await fs.promises.readFile(renamed), f.content);
});

test("corrupt downloads and insufficient memory leave pointer and original blob intact", async (t) => {
  const f = await fixture(t);
  const original = await fs.promises.readFile(f.localPath);
  await assert.rejects(pullLargeFile({...f, requestedPath: f.localPath, memoryAvailable: async () => 0}), /insufficient_memory/);
  f.objects.set(f.sourcePath, {content: Buffer.from("corrupt")});
  await assert.rejects(pullLargeFile({...f, requestedPath: f.localPath, memoryAvailable: async () => 1024 ** 3}), /checksum_mismatch/);
  assert.deepEqual(await fs.promises.readFile(f.localPath), original);
  assert.deepEqual((await fs.promises.readdir(path.dirname(f.config.workspaceDir))).sort(), ["workspace"]);
});

test("pull rejects symlinks, traversal and tampered manifest before fetching", async (t) => {
  const f = await fixture(t);
  const link = path.join(f.config.workspaceDir, "link");
  await fs.promises.symlink(f.localPath, link);
  await assert.rejects(pullLargeFile({...f, requestedPath: link}), /symlink_rejected/);
  await assert.rejects(pullLargeFile({...f, requestedPath: path.join(f.config.workspaceDir, "..", "outside")}), /unsafe|invalid|traversal/i);
  f.objects.set(f.pointer.manifest.objectPath, {content: Buffer.from("{}")});
  await assert.rejects(pullLargeFile({...f, requestedPath: f.localPath, memoryAvailable: async () => 1024 ** 3}), /checksum|mismatch/i);
});
