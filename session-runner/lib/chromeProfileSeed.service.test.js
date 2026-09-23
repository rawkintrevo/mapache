"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const test = require("node:test");
const {
  createChromeProfileSeedService,
  chromeProfileSeedObjectPath,
} = require("./chromeProfileSeed.service");

function createStorage() {
  const objects = new Map();
  const metadata = new Map();
  let generation = 0;
  const storage = {
    objects,
    bucket: () => ({
      file: (name) => ({
        save: async (content) => {
          if (Buffer.isBuffer(content)) objects.set(name, Buffer.from(content));
          else objects.set(name, Buffer.from(String(content), "utf8"));
          generation += 1;
          metadata.set(name, {generation: String(generation), size: String(objects.get(name).length)});
        },
        getMetadata: async () => [metadata.get(name) || {generation: "0", size: "0"}],
        download: async (options) => {
          const content = objects.get(name);
          if (!content) throw Object.assign(new Error("missing"), {code: 404});
          if (options?.destination) await fs.promises.writeFile(options.destination, content);
          else return [Buffer.from(content)];
        },
      }),
    }),
  };
  return storage;
}

test("publishes a complete immutable seed before advancing current", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-chrome-seed-"));
  t.after(() => fs.promises.rm(root, {recursive: true, force: true}));
  const profileDir = path.join(root, "profile");
  await fs.promises.mkdir(path.join(profileDir, "Default", "Cache"), {recursive: true});
  await fs.promises.writeFile(path.join(profileDir, "Cookies"), "cookie-state");
  await fs.promises.writeFile(path.join(profileDir, "Default", "Cache", "ignored"), "cache");
  const storage = createStorage();
  const service = createChromeProfileSeedService({
    config: {
      bucketName: "workspace-bucket",
      chromeEnabled: true,
      chromeProfileDir: profileDir,
      prefix: "users/u/workspaces/w",
      workspaceId: "w",
    },
    storage,
    now: () => Date.parse("2026-09-23T18:00:00.000Z"),
    randomId: () => "seed-0001",
  });

  let authorityChecks = 0;
  const result = await service.publish({
    assertCurrentWriter: async () => { authorityChecks += 1; },
  });
  assert.equal(authorityChecks >= 1, true);
  assert.equal(result.descriptor.sourceWorkspaceId, "w");
  assert.equal(result.descriptor.byteLength > 0, true);
  assert.equal(result.descriptor.sha256, crypto.createHash("sha256")
      .update(storage.objects.get(result.descriptor.objectPath)).digest("hex"));
  assert.ok(storage.objects.has("users/u/workspaces/w/.mapache-internal/chrome-profile-seeds/v1/current.json"));
  const archive = storage.objects.get(result.descriptor.objectPath);
  const extractDir = path.join(root, "extract");
  await fs.promises.mkdir(extractDir);
  const extracted = spawnSync("tar", ["-xzf", "-", "-C", extractDir], {input: archive});
  assert.equal(extracted.status, 0, extracted.stderr.toString());
  assert.equal(await fs.promises.readFile(path.join(extractDir, "Cookies"), "utf8"), "cookie-state");
  await assert.rejects(fs.promises.stat(path.join(extractDir, "Default", "Cache", "ignored")), {code: "ENOENT"});
  assert.equal(service.status().lastPublished.seedVersion, result.descriptor.seedVersion);
});

test("private automation runners cannot publish a profile seed", async () => {
  let called = false;
  const service = createChromeProfileSeedService({
    config: {chromeEnabled: true, runtimeKind: "automation"},
    storage: {bucket: () => { called = true; return {}; }},
  });
  assert.deepEqual(await service.publish(), {enabled: true, skipped: true, reason: "private_runtime"});
  assert.equal(called, false);
});

test("rejects a selected seed whose archive generation or checksum changed", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-chrome-seed-restore-"));
  const profileDir = path.join(root, "profile");
  const descriptor = {
    schemaVersion: 1,
    kind: "mapache-chrome-profile-seed",
    sourceWorkspaceId: "w",
    bucketName: "workspace-bucket",
    seedVersion: "2026-09-23-seed-0001",
    objectPath: chromeProfileSeedObjectPath("users/u/workspaces/w", "2026-09-23-seed-0001"),
    objectGeneration: "1",
    byteLength: 4,
    sha256: "0".repeat(64),
    capturedAt: "2026-09-23T18:00:00.000Z",
  };
  const storage = createStorage();
  storage.objects.set(descriptor.objectPath, Buffer.from("bad!"));
  await storage.bucket().file(descriptor.objectPath).save(Buffer.from("bad!"));
  try {
    const service = createChromeProfileSeedService({
      config: {
        bucketName: "workspace-bucket",
        chromeEnabled: true,
        chromeProfileDir: profileDir,
        chromeProfileSeed: descriptor,
        prefix: "users/u/workspaces/w",
        runtimeKind: "automation",
        workspaceId: "w",
      },
      profile: {restoreArchive: async () => assert.fail("corrupt seed must not restore")},
      storage,
    });
    await assert.rejects(() => service.restore(), /chrome_profile_seed_checksum_mismatch/);
  } finally {
    await fs.promises.rm(root, {recursive: true, force: true});
  }
});
