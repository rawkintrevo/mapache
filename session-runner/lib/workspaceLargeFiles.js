"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const {Transform} = require("node:stream");
const {pipeline} = require("node:stream/promises");
const {agentSnapshotStoragePrefix} = require("./agentSnapshot.service");

const DEFAULT_THRESHOLD = 100 * 1024 * 1024;
const MAGIC = "mapache-large-file-v1\n";

function validateDescriptor(entry) {
  if (!Number.isSafeInteger(Number(entry.byteLength)) || Number(entry.byteLength) < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw new Error("large_file_descriptor_invalid");
  return {byteLength: Number(entry.byteLength), sha256: entry.sha256};
}

function shouldDefer(entry, config = {}) {
  return entry.storage === "large-file-v1" || Number(entry.byteLength) >
    (config.workspaceLargeFileThresholdBytes || DEFAULT_THRESHOLD);
}

function encodePointer(entry) {
  const {byteLength, sha256} = validateDescriptor(entry);
  return Buffer.from(`${MAGIC}sha256 ${sha256}\nsize ${byteLength}\n\nFetch with: mapache files pull <path>\n`);
}

function parsePointer(content) {
  if (content.length > 1024 || !content.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) return null;
  const match = content.toString("utf8").match(/^mapache-large-file-v1\nsha256 ([a-f0-9]{64})\nsize (\d+)\n\nFetch with: mapache files pull <path>\n$/);
  if (!match) throw new Error("large_file_pointer_invalid");
  return validateDescriptor({sha256: match[1], byteLength: Number(match[2])});
}

function largeObjectPath(namespace, entry) {
  const descriptor = validateDescriptor(entry);
  return `${namespace}/large-files/v1/sha256/${descriptor.sha256}`;
}

function meter(expected) {
  const hash = crypto.createHash("sha256");
  let byteLength = 0;
  const stream = new Transform({transform(chunk, _encoding, done) {
    byteLength += chunk.length;
    if (expected && byteLength > expected.byteLength) return done(new Error("large_file_size_mismatch"));
    hash.update(chunk);
    done(null, chunk);
  }});
  return {stream, result() {
    const result = {byteLength, sha256: hash.digest("hex")};
    if (expected && (byteLength !== expected.byteLength || result.sha256 !== expected.sha256)) {
      throw new Error("large_file_checksum_mismatch");
    }
    return result;
  }};
}

async function ensureBlob({bucket, source, namespace, descriptor}) {
  const objectPath = largeObjectPath(namespace, descriptor);
  const target = bucket.file(objectPath);
  try {
    await source.copy(target, {preconditionOpts: {ifGenerationMatch: 0},
      metadata: {mapacheImmutable: "1", mapacheSha256: descriptor.sha256}});
  } catch (error) {
    if (Number(error.code) !== 412) throw error;
  }
  const [metadata] = await target.getMetadata();
  if (Number(metadata.size) !== descriptor.byteLength || metadata.metadata?.mapacheSha256 !== descriptor.sha256) {
    throw new Error("large_file_blob_conflict");
  }
  return objectPath;
}

async function publishLargeFile({config, localPath, pointer, previousManifest, previousPointer,
  relativePath, mode, storage, fsImpl = fs}) {
  const namespace = agentSnapshotStoragePrefix(config);
  const bucket = storage.bucket(config.bucketName);
  let descriptor;
  let objectPath;
  if (pointer) {
    descriptor = validateDescriptor(pointer);
    const original = previousManifest?.files?.find((entry) => entry.kind === "workspace-file" &&
      entry.sha256 === descriptor.sha256 && Number(entry.byteLength) === descriptor.byteLength);
    if (!original || previousManifest.storagePrefix !== namespace ||
        previousPointer?.manifest?.bucketName !== config.bucketName) throw new Error("large_file_pointer_unrecognized");
    // Derive the source from trusted manifest identity, never from pointer text.
    const sourcePath = original.storage === "large-file-v1" ? largeObjectPath(namespace, descriptor) :
      `${namespace}/workspace-files/${previousPointer.generation}/${previousPointer.bootInstanceId}/${previousPointer.captureId}/objects/${original.path}`;
    const [metadata] = await bucket.file(sourcePath).getMetadata();
    if (Number(metadata.size) !== descriptor.byteLength) throw new Error("large_file_size_mismatch");
    if (original.storage === "large-file-v1") {
      if (metadata.metadata?.mapacheSha256 !== descriptor.sha256) throw new Error("large_file_blob_conflict");
      objectPath = sourcePath;
    } else {
      objectPath = await ensureBlob({bucket, source: bucket.file(sourcePath, {generation: metadata.generation}), namespace, descriptor});
    }
  } else {
    // Upload once through a bounded stream, then name the verified bytes by hash.
    // The temporary object is never reachable from a published manifest.
    const staged = bucket.file(`${namespace}/large-files/staging/${crypto.randomUUID()}`);
    const measured = meter();
    try {
      await pipeline(fsImpl.createReadStream(localPath), measured.stream,
        staged.createWriteStream({resumable: true, preconditionOpts: {ifGenerationMatch: 0}}));
      descriptor = measured.result();
      objectPath = await ensureBlob({bucket, source: staged, namespace, descriptor});
    } finally {
      await staged.delete({ignoreNotFound: true}).catch(() => {});
    }
  }
  return {path: relativePath, kind: "workspace-file", storage: "large-file-v1", mode,
    ...descriptor, objectPath};
}

module.exports = {DEFAULT_THRESHOLD, MAGIC, encodePointer, parsePointer, shouldDefer,
  largeObjectPath, validateDescriptor, meter, publishLargeFile};
