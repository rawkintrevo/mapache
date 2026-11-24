"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Produces a bounded digest of the retained filesystem without returning file
 * names, contents, or credential material. Symlinks are recorded but never
 * followed. The digest is intended for recovery evidence, not authorization.
 */
function createRetainedDiskDigestService({root, fsImpl = fs, maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES} = {}) {
  const diskRoot = path.resolve(String(root || ""));
  const entryLimit = boundedLimit(maxEntries, DEFAULT_MAX_ENTRIES, 1, 100_000);
  const byteLimit = boundedLimit(maxBytes, DEFAULT_MAX_BYTES, 1, 4 * 1024 * 1024 * 1024);

  async function digest() {
    if (!diskRoot || diskRoot === path.parse(diskRoot).root) throw digestError("retained_digest_root_invalid");
    const entries = [];
    let bytes = 0;
    await visit(diskRoot, "");
    entries.sort((left, right) => left.key.localeCompare(right.key));
    const hash = crypto.createHash("sha256");
    for (const entry of entries) hash.update(`${entry.key}\n`);
    return {
      version: 1,
      fileDigest: `sha256:${hash.digest("hex")}`,
      entryCount: entries.length,
      byteCount: bytes,
      bounded: true,
    };

    async function visit(target, relative) {
      const stats = await fsImpl.promises.lstat(target);
      if (entries.length >= entryLimit) throw digestError("retained_digest_entry_limit");
      const mode = stats.mode & 0o7777;
      if (stats.isSymbolicLink()) {
        const targetPath = await fsImpl.promises.readlink(target);
        entries.push({key: `${relative}\0symlink\0${mode}\0${targetPath}`});
        return;
      }
      if (stats.isDirectory()) {
        if (relative) entries.push({key: `${relative}\0directory\0${mode}`});
        const children = (await fsImpl.promises.readdir(target)).sort();
        for (const child of children) {
          const childRelative = relative ? `${relative}/${child}` : child;
          await visit(path.join(target, child), childRelative);
        }
        return;
      }
      if (!stats.isFile()) {
        entries.push({key: `${relative}\0other\0${mode}\0${stats.size}`});
        return;
      }
      const size = Number(stats.size);
      if (!Number.isSafeInteger(size) || size < 0 || bytes + size > byteLimit) {
        throw digestError("retained_digest_byte_limit");
      }
      const content = crypto.createHash("sha256");
      const stream = fsImpl.createReadStream(target);
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > byteLimit) {
          stream.destroy();
          throw digestError("retained_digest_byte_limit");
        }
        content.update(chunk);
      }
      entries.push({key: `${relative}\0file\0${mode}\0${size}\0${content.digest("hex")}`});
    }
  }

  return {digest};
}

function boundedLimit(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function digestError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, createRetainedDiskDigestService};
