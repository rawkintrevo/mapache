"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {Readable, Writable} = require("node:stream");
const {spawnSync} = require("node:child_process");
const test = require("node:test");
const {
  CHECKPOINT_SCHEMA_VERSION,
  collectWorkspaceEntries,
  createWorkspaceArchive,
  createWorkspaceCheckpointService,
  validateManifest,
  validateSessionTree,
} = require("./workspaceCheckpoint.service");
const {createMutationBarrier} = require("./mutationBarrier");

test("workspace checkpoint allowlist excludes credentials, IPC state, and reconstructible caches", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-checkpoint-allowlist-"));
  t.after(() => fs.promises.rm(root, {recursive: true, force: true}));
  await fs.promises.mkdir(path.join(root, ".git", "refs"), {recursive: true});
  await fs.promises.mkdir(path.join(root, "node_modules", "pkg"), {recursive: true});
  await fs.promises.mkdir(path.join(root, ".config", "gh"), {recursive: true});
  await fs.promises.mkdir(path.join(root, ".mapache-internal", "archives"), {recursive: true});
  await fs.promises.writeFile(path.join(root, "app.js"), "safe");
  await fs.promises.writeFile(path.join(root, ".env"), "TOKEN=secret");
  await fs.promises.writeFile(path.join(root, "credentials.json"), "secret");
  await fs.promises.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "cache");
  await fs.promises.writeFile(path.join(root, ".config", "gh", "hosts.yml"), "secret");
  await fs.promises.writeFile(path.join(root, ".git", "index.lock"), "lock");
  await fs.promises.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const entries = await collectWorkspaceEntries(root);
  assert.ok(entries.includes("./app.js"));
  assert.ok(entries.includes("./.git/HEAD"));
  assert.ok(!entries.includes("./.env"));
  assert.ok(!entries.includes("./credentials.json"));
  assert.ok(!entries.some((entry) => entry.includes("node_modules")));
  assert.ok(!entries.some((entry) => entry.includes(".mapache-internal")));

  const archive = path.join(root, "..", "checkpoint.tar.gz");
  await createWorkspaceArchive(archive, {workspaceDir: root});
  const listing = spawnSync("tar", ["-tzf", archive], {encoding: "utf8"});
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /app\.js/);
  assert.doesNotMatch(listing.stdout, /\.env|credentials|node_modules|\.mapache-internal|hosts\.yml|index\.lock/);
  await fs.promises.rm(archive, {force: true});
});

test("validates a complete session tree and rejects invalid parent bindings", () => {
  assert.deepEqual(validateSessionTree([
    JSON.stringify({id: "root"}),
    JSON.stringify({id: "leaf", parentId: "root"}),
  ].join("\n")).leafId, "leaf");
  assert.throws(() => validateSessionTree(JSON.stringify({id: "leaf", parentId: "missing"})), {code: "checkpoint_session_parent_missing"});
});

test("publishes immutable checkpoint objects and advances the paired recovery pointer", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mapache-checkpoint-service-"));
  t.after(() => fs.promises.rm(root, {recursive: true, force: true}));
  await fs.promises.mkdir(path.join(root, ".pi"), {recursive: true});
  await fs.promises.writeFile(path.join(root, "index.js"), "safe");
  const piSessionDir = path.join(root, "sessions");
  await fs.promises.mkdir(piSessionDir, {recursive: true});
  await fs.promises.writeFile(path.join(piSessionDir, "session.jsonl"), `${JSON.stringify({id: "root"})}\n${JSON.stringify({id: "leaf", parentId: "root"})}\n`);
  const storage = fakeStorage();
  const db = fakeFirestore({
    "workspaces/workspace-1": {
      syncWriterSessionId: "session-1",
      syncWriterLeaseId: "writer-1",
      executionAuthority: {state: "active", runtimeId: "runtime-1", executionEpoch: 3, sessionId: "session-1"},
    },
    "workspaces/workspace-1/sessions/session-1": {
      syncWriterRole: "writer",
      syncWriterLeaseId: "writer-1",
    },
  });
  const durable = [];
  const service = createWorkspaceCheckpointService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "server-time"}}},
    config: {
      webFirstEnabled: true,
      workspaceId: "workspace-1",
      sessionId: "session-1",
      workspaceDir: root,
      piSessionDir,
      piSessionStorageBucket: "bucket",
      piSessionStoragePrefix: "workspaces/workspace-1/.mapache-internal/sessions/session-1/pi-session",
    },
    db,
    storage,
    authority: {canMutate: () => true, assertAuthority() {}, snapshot: () => ({runtimeId: "runtime-1", executionEpoch: 3})},
    barrier: createMutationBarrier(),
    adapter: {identity: () => ({piSession: "pi-session-1", adapter: "gate-c-1", protocol: "mapache-pi-web-first/1", package: {name: "pi-goal-x", version: "0.31.2"}})},
    goals: {snapshot: async () => ({ok: true, goals: [{id: "goal-1"}]})},
    ledger: {list: () => [{commandId: "command-1"}], snapshot: () => ({operations: [{commandId: "command-1"}], events: []}), setDurability: async (id, state) => durable.push({id, state})},
  });
  const result = await service.create({reason: "test"});
  assert.equal(result.ok, true);
  assert.equal(result.recovery.executionEpoch, 3);
  assert.equal(db.value("workspaces/workspace-1/sessions/session-1").recovery.checkpointId, result.checkpointId);
  assert.deepEqual(durable, [{id: "command-1", state: "checkpoint_committed"}]);
  const uploaded = Object.keys(storage.files);
  assert.equal(uploaded.filter((name) => name.endsWith("manifest.json")).length, 1);
  assert.ok(uploaded.some((name) => name.endsWith("workspace-snapshot.tar.gz")));
  await service.verifyRecovery();
  assert.equal(service.status().blocked, false);
});

test("manifest validation rejects duplicate and stale bindings", () => {
  const base = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    checkpointId: "cp-1",
    executionEpoch: 3,
    runtimeId: "runtime-1",
    objects: ["pi-session.jsonl", "managed-goal-state.json", "workspace-snapshot.tar.gz", "operation-evidence.json"].map((name) => ({name: `root/epochs/3/checkpoints/cp-1/${name}`, generation: "1", sha256: "a".repeat(64), byteLength: 1})),
  };
  validateManifest(base, {checkpointId: "cp-1", executionEpoch: 3, runtimeId: "runtime-1"});
  assert.throws(() => validateManifest({...base, objects: [...base.objects, {...base.objects[0]}]}, {checkpointId: "cp-1", executionEpoch: 3, runtimeId: "runtime-1"}), {code: "checkpoint_manifest_objects_invalid"});
  assert.throws(() => validateManifest(base, {checkpointId: "cp-1", executionEpoch: 4, runtimeId: "runtime-1"}), {code: "checkpoint_manifest_binding_invalid"});
});

function fakeStorage() {
  const files = {};
  return {
    files,
    bucket() {
      return {
        file(name) {
          if (!files[name]) files[name] = fakeFile(name);
          return files[name];
        },
        async getFiles({prefix}) {
          return [Object.values(files).filter((file) => file.name.startsWith(prefix))];
        },
      };
    },
  };
}

function fakeFile(name) {
  let data = Buffer.alloc(0);
  let generation = 0;
  let metadata = {};
  return {
    name,
    createWriteStream(options) {
      if (options.preconditionOpts?.ifGenerationMatch === 0 && generation) {
        const stream = new Writable({write(_chunk, _encoding, callback) { callback(new Error("precondition failed")); }});
        return stream;
      }
      const stream = new Writable({write(chunk, _encoding, callback) { data = Buffer.concat([data, chunk]); callback(); }});
      stream.on("finish", () => {
        generation += 1;
        metadata = options.metadata || {};
      });
      return stream;
    },
    async getMetadata() {
      return [{generation: String(generation), size: String(data.length), metadata, updated: new Date().toISOString()}];
    },
    async download({destination}) { await fs.promises.writeFile(destination, data); },
    async delete() { data = Buffer.alloc(0); generation = 0; },
    async exists() { return [Boolean(generation)]; },
    createReadStream() { return Readable.from(data); },
  };
}

function fakeFirestore(initial) {
  const values = new Map(Object.entries(initial));
  const makeRef = (key) => ({
    key,
    collection(name) { return makeRef(`${key}/${name}`); },
    doc(name) { return makeRef(`${key}/${name}`); },
    async get() { const value = values.get(key); return {exists: value !== undefined, data: () => value && JSON.parse(JSON.stringify(value))}; },
  });
  return {
    collection(name) { return makeRef(name); },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {get: (ref) => ref.get(), set: (ref, value, options = {}) => writes.push({ref, value, options}), update: (ref, value) => writes.push({ref, value, options: {merge: true}})};
      const result = await callback(transaction);
      for (const write of writes) values.set(write.ref.key, write.options.merge ? {...(values.get(write.ref.key) || {}), ...write.value} : write.value);
      return result;
    },
    value(key) { return values.get(key); },
  };
}
