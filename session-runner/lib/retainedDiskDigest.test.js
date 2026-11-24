"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createRetainedDiskDigestService} = require("./retainedDiskDigest");

test("retained disk digest is stable, bounded, and does not expose paths", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-digest-"));
  try {
    await fs.promises.mkdir(path.join(root, "workspace"));
    await fs.promises.writeFile(path.join(root, "workspace", "state.txt"), "durable-state\n", {mode: 0o600});
    await fs.promises.symlink("state.txt", path.join(root, "workspace", "state-link"));
    const service = createRetainedDiskDigestService({root});
    const first = await service.digest();
    const second = await service.digest();
    assert.deepEqual(first, second);
    assert.match(first.fileDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.bounded, true);
    assert.equal(Object.hasOwn(first, "paths"), false);
    assert.equal(Object.hasOwn(first, "files"), false);
    assert.ok(first.entryCount >= 3);
  } finally {
    await fs.promises.rm(root, {recursive: true, force: true});
  }
});

test("retained disk digest refuses a byte-limit overrun", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-digest-limit-"));
  try {
    await fs.promises.writeFile(path.join(root, "large"), "1234567890");
    const service = createRetainedDiskDigestService({root, maxBytes: 5});
    await assert.rejects(service.digest(), error => error.code === "retained_digest_byte_limit");
  } finally {
    await fs.promises.rm(root, {recursive: true, force: true});
  }
});
