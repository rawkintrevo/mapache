"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  chromeProfileSeedObjectPath,
  readCurrentChromeProfileSeed,
  selectAutomationChromeProfileSeed,
  validateChromeProfileSeedDescriptor,
} = require("./chromeProfileSeed.service");

const bucketName = "workspace-bucket";
const workspaceId = "workspace-1";
const prefix = "users/user-1/workspaces/workspace-1";

function seedDescriptor(overrides = {}) {
  const content = Buffer.from("profile-seed");
  return {
    schemaVersion: 1,
    kind: "mapache-chrome-profile-seed",
    sourceWorkspaceId: workspaceId,
    bucketName,
    seedVersion: "2026-09-23-seed-0001",
    objectPath: chromeProfileSeedObjectPath(prefix, "2026-09-23-seed-0001"),
    objectGeneration: "7",
    byteLength: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    capturedAt: "2026-09-23T18:00:00.000Z",
    browser: {family: "chromium", runtime: "pi-chrome"},
    ...overrides,
  };
}

function storageFor(descriptor, options = {}) {
  const currentPath = `${prefix}/.mapache-internal/chrome-profile-seeds/v1/current.json`;
  const objects = new Map([
    [currentPath, Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8")],
    [descriptor.objectPath, Buffer.from("profile-seed")],
  ]);
  return {
    bucket: () => ({
      file: (name) => ({
        download: async () => {
          if (!objects.has(name)) throw Object.assign(new Error("missing"), {code: 404});
          return [objects.get(name)];
        },
        getMetadata: async () => [{
          generation: descriptor.objectGeneration,
          size: String(objects.get(name)?.length || 0),
        }],
      }),
    }),
    ...options,
  };
}

function sessions(sources = []) {
  return () => ({get: async () => ({docs: sources.map((data, index) => ({id: `session-${index}`, data: () => data}))})});
}

test("validates workspace ownership and immutable seed object paths", () => {
  const descriptor = seedDescriptor();
  assert.deepEqual(validateChromeProfileSeedDescriptor(descriptor, {
    workspaceId,
    bucketName,
    workspaceStoragePrefix: prefix,
  }).seedVersion, descriptor.seedVersion);
  assert.throws(() => validateChromeProfileSeedDescriptor({...descriptor, sourceWorkspaceId: "other"}, {
    workspaceId,
    bucketName,
    workspaceStoragePrefix: prefix,
  }), /chrome_profile_seed_descriptor_invalid/);
  assert.throws(() => validateChromeProfileSeedDescriptor({...descriptor, objectPath: "other/profile.tar.gz"}, {
    workspaceId,
    bucketName,
    workspaceStoragePrefix: prefix,
  }), /chrome_profile_seed_descriptor_invalid/);
});

test("uses the latest complete seed when the workspace browser is stopped", async () => {
  const descriptor = seedDescriptor();
  const selected = await selectAutomationChromeProfileSeed({
    sessionCollection: sessions([]),
    storage: storageFor(descriptor),
    workspace: {id: workspaceId, bucket: bucketName, storagePrefix: prefix},
  });
  assert.equal(selected.mode, "inherited");
  assert.equal(selected.reason, "latest_published");
  assert.equal(selected.descriptor.seedVersion, descriptor.seedVersion);
});

test("distinguishes a genuine no-seed workspace from a failed capture", async () => {
  const fresh = await selectAutomationChromeProfileSeed({
    sessionCollection: sessions([]),
    storage: {bucket: () => ({file: () => ({download: async () => { throw Object.assign(new Error("missing"), {code: 404}); }})})},
    workspace: {id: workspaceId, bucket: bucketName, storagePrefix: prefix},
  });
  assert.deepEqual(fresh, {mode: "fresh", reason: "no_seed", descriptor: null, ageMs: null});

  const descriptor = seedDescriptor();
  await assert.rejects(() => selectAutomationChromeProfileSeed({
    requestRunnerJson: async () => { throw Object.assign(new Error("capture timed out"), {code: "chrome_profile_capture_timeout"}); },
    sessionCollection: sessions([{
      status: "running",
      serviceUrl: "https://workspace.example",
      shutdownToken: "runner-token",
      capabilities: {chrome: true},
    }]),
    storage: storageFor(descriptor),
    workspace: {id: workspaceId, bucket: bucketName, storagePrefix: prefix},
  }), (error) => error.code === "chrome_profile_capture_timeout");
});

test("pins a fresh capture from the owning workspace and never accepts a sibling seed", async () => {
  const descriptor = seedDescriptor();
  let requested = null;
  const selected = await selectAutomationChromeProfileSeed({
    requestRunnerJson: async (_session, route, options) => {
      requested = {route, options};
      return {seed: descriptor};
    },
    sessionCollection: sessions([{
      status: "running",
      serviceUrl: "https://workspace.example",
      shutdownToken: "runner-token",
      capabilities: {chrome: true},
    }]),
    storage: storageFor(descriptor),
    workspace: {id: workspaceId, bucket: bucketName, storagePrefix: prefix},
  });
  assert.equal(selected.reason, "fresh_capture");
  assert.equal(selected.descriptor.seedVersion, descriptor.seedVersion);
  assert.equal(requested.route, "/workspace/chrome-profile/snapshot");
  assert.equal(requested.options.method, "POST");
});

test("rejects a corrupt current descriptor before provisioning", async () => {
  const descriptor = seedDescriptor({sha256: "0".repeat(64)});
  await assert.rejects(() => readCurrentChromeProfileSeed({
    storage: storageFor(descriptor),
    bucketName,
    workspaceId,
    workspaceStoragePrefix: prefix,
  }), /chrome_profile_seed_checksum_mismatch/);
});

test("reuses an existing automation session seed before considering a newer current seed", async () => {
  const descriptor = seedDescriptor();
  const selected = await selectAutomationChromeProfileSeed({
    sessionCollection: (workspace) => ({
      doc: (sessionId) => ({
        get: async () => ({
          exists: workspace === workspaceId && sessionId === "auto-run-1",
          data: () => ({chromeProfileSeed: descriptor}),
        }),
      }),
      get: async () => ({docs: []}),
    }),
    storage: storageFor(descriptor),
    run: {runId: "run-1", workspaceId},
    workspace: {id: workspaceId, bucket: bucketName, storagePrefix: prefix},
  });
  assert.equal(selected.reason, "pinned");
  assert.equal(selected.descriptor.seedVersion, descriptor.seedVersion);
});
