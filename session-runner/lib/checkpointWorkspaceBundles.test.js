"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const {STORAGE, BUNDLE_BYTES, FILE_BYTES, bundleWorkspaceSources, encodeWorkspaceBundle, createWorkspaceBundleReader} = require("./checkpointWorkspaceBundles");
const {encodePointer} = require("./workspaceLargeFiles");

test("thousands of small tool files use one verified shared download", async () => {
  const files = Array.from({length: 15000}, (_, index) => ({path: `.local/lib/node_modules/tool/${index}`, content: `file-${index}`}));
  const sources = await bundleWorkspaceSources({files, fsImpl: fs});
  assert.equal(sources.length, 1);
  const encoded = await encodeWorkspaceBundle({source: sources[0], fsImpl: fs, basePath: "capture"});
  let downloads = 0;
  const reader = createWorkspaceBundleReader({basePath: "capture", bucketName: "bucket", storage: {
    bucket: () => ({file: () => ({download: async () => { downloads++; return [encoded.content]; }})}),
  }});
  for (let index = 0; index < files.length; index += 64) {
    const result = await Promise.all(encoded.files.slice(index, index + 64).map(reader));
    for (let offset = 0; offset < result.length; offset++) assert.equal(result[offset].toString(), files[index + offset].content);
  }
  assert.equal(downloads, 1);
});

test("bundle planning bounds bytes and leaves large files, pointers and non-tools on existing paths", async () => {
  const large = {path: ".local/large", content: Buffer.alloc(FILE_BYTES + 1)};
  const pointer = {path: ".local/model.pt", content: encodePointer({sha256: "a".repeat(64), byteLength: 200000000})};
  const ordinary = {path: "src/index.js", content: "app"};
  const sources = await bundleWorkspaceSources({fsImpl: fs, files: [
    ...Array.from({length: 10}, (_, index) => ({path: `.local/${index}`, content: Buffer.alloc(FILE_BYTES)})), large, pointer, ordinary,
  ]});
  const bundles = sources.filter((entry) => entry.kind === STORAGE);
  assert.deepEqual(bundles.map((entry) => entry.byteLength), [BUNDLE_BYTES, 2 * FILE_BYTES]);
  assert.ok(sources.includes(large));
  assert.ok(sources.includes(pointer));
  assert.ok(sources.includes(ordinary));
});

test("bundle reader rejects namespace escapes, invalid ranges and corrupted bundle or file checksums", async () => {
  const [source] = await bundleWorkspaceSources({files: [{path: ".local/tool", content: "tool"}], fsImpl: fs});
  const encoded = await encodeWorkspaceBundle({source, fsImpl: fs, basePath: "capture"});
  const createReader = (content = encoded.content) => createWorkspaceBundleReader({basePath: "capture", bucketName: "bucket", storage: {
    bucket: () => ({file: () => ({download: async () => [content]})}),
  }});
  const entry = encoded.files[0];
  for (const patch of [
    {bundleOffset: -1}, {bundleOffset: 1}, {byteLength: FILE_BYTES + 1},
    {bundle: {...entry.bundle, objectPath: "other/capture"}},
    {bundle: {...entry.bundle, byteLength: BUNDLE_BYTES + 1}},
    {sha256: "a".repeat(64)},
  ]) await assert.rejects(createReader()({...entry, ...patch}));
  await assert.rejects(createReader(Buffer.from("evil"))(entry), {code: "checkpoint_checksum_mismatch"});
});

test("identical bundle payloads at different positions have distinct immutable object names", async () => {
  const sources = await bundleWorkspaceSources({fsImpl: fs, files: [
    {path: ".local/a", content: "same"}, {path: "src/b", content: "outside"}, {path: ".local/c", content: "same"},
  ]});
  const encoded = await Promise.all(sources.filter((source) => source.kind === STORAGE)
      .map((source) => encodeWorkspaceBundle({source, fsImpl: fs, basePath: "capture"})));
  assert.notEqual(encoded[0].bundle.objectPath, encoded[1].bundle.objectPath);
});
