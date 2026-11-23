"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const {parsePointer} = require("./workspaceLargeFiles");
const BUNDLE_BYTES = 8 * 1024 * 1024;
const FILE_BYTES = 1024 * 1024;
const STORAGE = "workspace-bundle-v1";
const hash = (content) => crypto.createHash("sha256").update(content).digest("hex");
const invalid = () => Object.assign(new Error("Invalid workspace checkpoint bundle"), {code: "checkpoint_manifest_invalid"});

async function bundleWorkspaceSources({files, fsImpl, sourceRoot}) {
  const result = [];
  let group = [];
  let byteLength = 0;
  let sequence = 0;
  const flush = () => {
    if (group.length) result.push({kind: STORAGE, files: group, byteLength, id: String(sequence++).padStart(6, "0")});
    group = [];
    byteLength = 0;
  };
  for (const file of files) {
    if (file.kind === "symlink") {
      result.push(file);
      continue;
    }
    if (!file.path.startsWith(".local/")) {
      flush();
      result.push(file);
      continue;
    }
    const localPath = file.localPath || (sourceRoot ? path.resolve(sourceRoot, file.path) : undefined);
    const stat = file.content === undefined ? await fsImpl.promises.lstat(localPath) : null;
    if (stat && !stat.isFile()) throw invalid();
    const size = stat ? stat.size : Buffer.byteLength(file.content);
    // Preserve the existing deferred-large-file reference contract.
    const pointer = size <= 1024 && parsePointer(file.content === undefined ?
      await fsImpl.promises.readFile(localPath) : Buffer.from(file.content));
    if (size > FILE_BYTES || pointer) {
      flush();
      result.push(file);
      continue;
    }
    if (byteLength + size > BUNDLE_BYTES) flush();
    group.push({...file, localPath, plannedSize: size, plannedMode: stat ? stat.mode & 0o777 : file.mode || 0o600});
    byteLength += size;
  }
  flush();
  return result;
}

async function encodeWorkspaceBundle({source, fsImpl, basePath}) {
  const content = Buffer.alloc(source.byteLength);
  const files = [];
  let offset = 0;
  for (const file of source.files) {
    const bytes = file.content === undefined ? await fsImpl.promises.readFile(file.localPath) : Buffer.from(file.content);
    if (bytes.length !== file.plannedSize) throw Object.assign(new Error("Workspace file changed during bundle capture"), {code: "checkpoint_workspace_changed"});
    bytes.copy(content, offset);
    files.push({path: file.path, kind: "workspace-file", storage: STORAGE,
      byteLength: bytes.length, sha256: hash(bytes), mode: file.plannedMode, bundleOffset: offset});
    offset += bytes.length;
  }
  const sha256 = hash(content);
  const bundle = {id: source.id, objectPath: `${basePath}/bundles/${source.id}-${sha256}`, byteLength: content.length, sha256};
  for (const file of files) file.bundle = bundle;
  return {content, bundle, files};
}

function createWorkspaceBundleReader({basePath, bucketName, storage}) {
  // Share downloads within/between staging batches, retaining at most two
  // completed 8 MiB bundles plus one download. Copy returned slices so a tiny
  // file cannot retain an evicted bundle while its disk write is pending.
  const cache = new Map();
  let downloads = Promise.resolve();
  return async function read(entry) {
    const bundle = entry.bundle || {};
    if (entry.storage !== STORAGE || !/^[a-f0-9]{64}$/.test(bundle.sha256 || "") ||
        !/^\d{6,12}$/.test(bundle.id || "") || bundle.objectPath !== `${basePath}/bundles/${bundle.id}-${bundle.sha256}` ||
        !Number.isSafeInteger(bundle.byteLength) || bundle.byteLength < 0 || bundle.byteLength > BUNDLE_BYTES ||
        !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || entry.byteLength > FILE_BYTES ||
        !Number.isSafeInteger(entry.bundleOffset) || entry.bundleOffset < 0 ||
        entry.bundleOffset + entry.byteLength > bundle.byteLength || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw invalid();
    let item = cache.get(bundle.objectPath);
    if (item && item.byteLength !== bundle.byteLength) throw invalid();
    if (!item) {
      item = {byteLength: bundle.byteLength, settled: false};
      item.promise = downloads.then(() => storage.bucket(bucketName).file(bundle.objectPath).download()).then(([content]) => {
        if (content.length !== bundle.byteLength || hash(content) !== bundle.sha256) {
          throw Object.assign(new Error("Workspace bundle checksum mismatch"), {code: "checkpoint_checksum_mismatch"});
        }
        item.settled = true;
        const completed = [...cache.entries()].filter(([, value]) => value.settled);
        for (const [key] of completed.slice(0, -2)) cache.delete(key);
        return content;
      });
      downloads = item.promise.then(() => undefined, () => undefined);
      cache.set(bundle.objectPath, item);
    }
    const content = (await item.promise).subarray(entry.bundleOffset, entry.bundleOffset + entry.byteLength);
    if (hash(content) !== entry.sha256) {
      throw Object.assign(new Error("Workspace bundle file checksum mismatch"), {code: "checkpoint_checksum_mismatch"});
    }
    return Buffer.from(content);
  };
}

module.exports = {STORAGE, BUNDLE_BYTES, FILE_BYTES, bundleWorkspaceSources, encodeWorkspaceBundle, createWorkspaceBundleReader};
