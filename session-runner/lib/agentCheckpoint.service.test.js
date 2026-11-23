"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {agentSnapshotStoragePrefix} = require("./agentSnapshot.service");
const {
  createAgentCheckpointService,
  uploadCapture,
} = require("./agentCheckpoint.service");

const admin = {
  firestore: {FieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"}},
};

function configFor(root, overrides = {}) {
  return {
    agentRuntimeEnabled: true,
    agentRuntimeGeneration: "7",
    agentRuntimeBootInstanceId: "boot-a",
    agentUiVersion: "pi-web-ui-v1",
    bucketName: "workspace-bucket",
    internalStorageDir: ".mapache-internal",
    prefix: "users/u/workspaces/workspace-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    workspaceDir: path.join(root, "workspace"),
    ...overrides,
  };
}

function createStore({workspace = {}, session = {}} = {}) {
  const workspaceData = workspace;
  const sessionData = session;
  const workspaceRef = {
    id: "workspace-1",
    collection(name) {
      assert.equal(name, "sessions");
      return {doc: (id) => {
        assert.equal(id, "session-1");
        return sessionRef;
      }};
    },
    async get() {
      return {exists: true, data: () => workspaceData};
    },
  };
  const sessionRef = {
    id: "session-1",
    async get() {
      return {exists: true, data: () => sessionData};
    },
  };
  return {
    db: {
      collection(name) {
        assert.equal(name, "workspaces");
        return {doc: (id) => {
          assert.equal(id, "workspace-1");
          return workspaceRef;
        }};
      },
      async runTransaction(callback) {
        return callback({
          async get(ref) {
            if (ref === workspaceRef) return workspaceRef.get();
            return sessionRef.get();
          },
          update(ref, updates) {
            Object.assign(ref === workspaceRef ? workspaceData : sessionData, updates);
          },
        });
      },
    },
    session: sessionData,
    workspace: workspaceData,
  };
}

function admittedStore() {
  return createStore({
    workspace: {
      agentUiVersion: "pi-web-ui-v1",
      agentRuntimeSessionId: "session-1",
      agentRuntimeGeneration: 7,
      agentRuntimeBootInstanceId: "boot-a",
      agentRuntimeAuthorityState: "admitted",
    },
    session: {
      agentUiVersion: "pi-web-ui-v1",
      agentRuntimeGeneration: 7,
      agentRuntimeBootInstanceId: "boot-a",
      agentRuntimeAuthorityState: "admitted",
    },
  });
}

function createStorage({failOnUploadNumber = 0} = {}) {
  const objects = new Map();
  const uploads = [];
  const deletes = [];
  const metadata = new Map();
  let uploadNumber = 0;
  function file(bucketName, objectPath) {
    const key = `${bucketName}/${objectPath}`;
    return {
      name: objectPath,
      async getMetadata() { return [{size: objects.get(key).length, generation: "1", metadata: metadata.get(key) || {}}]; },
      async copy(target, options) {
        const destination = `${bucketName}/${target.name}`;
        if (objects.has(destination)) throw Object.assign(new Error("exists"), {code: 412});
        objects.set(destination, objects.get(key));
        metadata.set(destination, options.metadata);
      },
      async save(content, options) {
        uploadNumber += 1;
        if (uploadNumber === failOnUploadNumber) throw Object.assign(new Error("injected upload failure"), {code: "storage_failed"});
        objects.set(key, Buffer.from(content));
        uploads.push({bucketName, objectPath, options});
      },
      async download() {
        if (!objects.has(key)) throw Object.assign(new Error("not found"), {code: 404});
        return [objects.get(key)];
      },
      async delete() {
        deletes.push(key);
        objects.delete(key);
      },
    };
  }
  return {
    bucket(bucketName) {
      return {
        file: (objectPath) => file(bucketName, objectPath),
        async upload(localPath, options) {
          const content = await fs.readFile(localPath);
          return file(bucketName, options.destination).save(content, options);
        },
      };
    },
    deletes,
    objects,
    uploads,
  };
}

async function makeCapture(t, config, files = {"sessions/chat.jsonl": "{\"type\":\"session\"}\n"}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-checkpoint-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  for (const [relativePath, content] of Object.entries(files)) {
    const localPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(localPath), {recursive: true});
    await fs.writeFile(localPath, content);
  }
  const manifest = {
    manifestVersion: 1,
    kind: "mapache-agent-state-snapshot",
    storagePrefix: agentSnapshotStoragePrefix(config),
    workspaceId: config.workspaceId,
    sessionId: config.sessionId,
    generation: 7,
    bootInstanceId: "boot-a",
    capturedAt: "2026-09-11T12:00:00.000Z",
    files: Object.entries(files).map(([relativePath, content]) => ({
      path: relativePath,
      kind: "transcript",
      byteLength: Buffer.byteLength(content),
      sha256: require("node:crypto").createHash("sha256").update(content).digest("hex"),
      mode: 0o600,
    })),
  };
  return {manifest, stagingDir: root, captureId: "capture-local"};
}

test("uploadCapture writes unique immutable objects without mutating the checkpoint pointer", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-checkpoint-test-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  const store = admittedStore();
  store.workspace.agentRuntimeCheckpoint = {captureId: "previous"};
  const storage = createStorage();
  const capture = await makeCapture(t, config, {
    "sessions/a.jsonl": "{\"a\":1}\n",
    "ui/client-state.json": "{\"theme\":\"dark\"}\n",
  });

  const result = await uploadCapture({admin, capture, config, db: store.db, storage});

  assert.equal(result.manifestRef.objectPath.endsWith("/manifest.json"), true);
  assert.equal(result.objects.length, 3);
  assert.equal(new Set(result.objects.map((object) => object.objectPath)).size, 3);
  assert.deepEqual(store.workspace.agentRuntimeCheckpoint, {captureId: "previous"});
  assert.equal(storage.uploads.every(({options}) => options.preconditionOpts.ifGenerationMatch === 0), true);
  assert.equal(storage.uploads.at(-1).objectPath, result.manifestRef.objectPath);
});

test("partial capture upload leaves the previous checkpoint pointer unchanged", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-checkpoint-test-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  const store = admittedStore();
  store.workspace.agentRuntimeCheckpoint = {captureId: "previous"};
  const capture = await makeCapture(t, config, {
    "sessions/a.jsonl": "{\"a\":1}\n",
    "sessions/b.jsonl": "{\"b\":2}\n",
  });

  await assert.rejects(
      uploadCapture({admin, capture, config, db: store.db, storage: createStorage({failOnUploadNumber: 2})}),
      (error) => error.code === "storage_failed",
  );
  assert.deepEqual(store.workspace.agentRuntimeCheckpoint, {captureId: "previous"});
});

test("commitCheckpoint rejects a writer revoked after upload", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-checkpoint-test-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  const store = admittedStore();
  const storage = createStorage();
  const capture = await makeCapture(t, config);
  const uploaded = await uploadCapture({admin, capture, config, db: store.db, storage});
  store.workspace.agentRuntimeAuthorityState = "released";
  store.session.agentRuntimeAuthorityState = "released";

  const service = createAgentCheckpointService({admin, config, db: store.db, storage});
  await assert.rejects(
      service.commitCheckpoint(uploaded),
      (error) => error.code === "checkpoint_writer_not_current",
  );
  assert.equal(store.workspace.agentRuntimeCheckpoint, undefined);
});

test("commitCheckpoint rejects a pending upload after workspace tombstoning", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-checkpoint-test-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  const store = admittedStore();
  const capture = await makeCapture(t, config);
  const uploaded = await uploadCapture({admin, capture, config, db: store.db, storage: createStorage()});
  store.workspace.deleted = true;
  store.workspace.lifecycle = "deleting";

  const service = createAgentCheckpointService({admin, config, db: store.db, storage: createStorage()});
  await assert.rejects(
      service.commitCheckpoint(uploaded),
      (error) => error.code === "checkpoint_workspace_deleted",
  );
});

test("automation checkpoints update only the run session pointer", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-checkpoint-test-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root, {runtimeKind: "automation", automationRunId: "run-1", sessionId: "session-1"});
  const store = admittedStore();
  store.workspace.agentRuntimeCheckpoint = {captureId: "main-pointer"};
  Object.assign(store.session, {
    runtimeKind: "automation",
    automationRunId: "run-1",
    agentRuntimeSessionId: "session-1",
  });
  const capture = await makeCapture(t, config);
  const uploaded = await uploadCapture({admin, capture, config, db: store.db, storage: createStorage()});
  const result = await createAgentCheckpointService({admin, config, db: store.db, storage: createStorage()}).commitCheckpoint(uploaded);

  assert.equal(result.ok, true);
  assert.deepEqual(store.workspace.agentRuntimeCheckpoint, {captureId: "main-pointer"});
  assert.equal(store.session.agentRuntimeCheckpoint.captureId, "capture-local");
});

test("publishWorkspaceFiles commits tombstones and stale delayed writers cannot delete newer files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-checkpoint-test-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  const store = admittedStore();
  const storage = createStorage();
  const service = createAgentCheckpointService({admin, config, db: store.db, storage, randomId: (() => {
    let count = 0;
    return () => `capture-${++count}`;
  })()});

  const first = await service.publishWorkspaceFiles({
    basePointer: null,
    bootInstanceId: "boot-a",
    files: [{path: "keep.txt", content: "v1"}, {path: "remove.txt", content: "old"}],
    generation: 7,
    sessionId: "session-1",
    workspaceId: "workspace-1",
  });
  const successor = await service.publishWorkspaceFiles({
    basePointer: first.pointer,
    bootInstanceId: "boot-a",
    files: [{path: "keep.txt", content: "v2"}],
    generation: 7,
    sessionId: "session-1",
    workspaceId: "workspace-1",
  });
  assert.deepEqual(successor.manifest.tombstones, ["remove.txt"]);

  await assert.rejects(
      service.publishWorkspaceFiles({
        basePointer: first.pointer,
        bootInstanceId: "boot-a",
        files: [{path: "keep.txt", content: "stale"}],
        generation: 7,
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
      (error) => error.code === "checkpoint_publication_conflict",
  );
  assert.equal(store.workspace.agentRuntimeWorkspaceFiles.captureId, successor.pointer.captureId);
  assert.equal(storage.deletes.length, 0);
  assert.equal(storage.objects.has(`workspace-bucket/${successor.manifestRef.objectPath}`), true);
});

test("checkpoint status exposes only the safe timestamp and error code", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-checkpoint-test-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  const store = admittedStore();
  store.session.agentRuntimeLastCheckpointAt = "2026-09-11T12:00:00.000Z";
  store.session.agentRuntimeCheckpointError = "checkpoint_upload_failed";
  const service = createAgentCheckpointService({config, db: store.db});

  assert.deepEqual(await service.status(), {
    lastCheckpointAt: "2026-09-11T12:00:00.000Z",
    checkpointError: "checkpoint_upload_failed",
  });
});

test("pointer publication preserves model bytes through rename, restart and deletion", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-large-checkpoint-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  const store = admittedStore();
  const storage = createStorage();
  let sequence = 0;
  const publisher = createAgentCheckpointService({admin, config, db: store.db, storage, randomId: () => `capture-${++sequence}`});
  const first = await publisher.publishWorkspaceFiles({files: [{path: "model.pt", content: "original-model"}]});
  const {encodePointer} = require("./workspaceLargeFiles");
  const pointerContent = encodePointer(first.manifest.files[0]);
  const second = await publisher.publishWorkspaceFiles({files: [{path: "renamed.pt", content: pointerContent}]});
  assert.equal(second.manifest.files[0].storage, "large-file-v1");
  assert.deepEqual(second.manifest.tombstones, ["model.pt"]);
  const blob = second.manifest.files[0].objectPath;
  assert.equal(storage.objects.get(`${config.bucketName}/${blob}`).toString(), "original-model");
  const third = await publisher.publishWorkspaceFiles({files: [{path: "renamed.pt", content: pointerContent}]});
  assert.equal(third.manifest.files[0].objectPath, blob);
  // A replacement runner restores the CAS-backed entry as a pointer too.
  await fs.mkdir(config.workspaceDir);
  const {createAgentCheckpointRestoreService} = require("./agentCheckpointRestore.service");
  await createAgentCheckpointRestoreService({config, db: store.db, storage}).restoreWorkspaceFiles();
  assert.deepEqual(await fs.readFile(path.join(config.workspaceDir, "renamed.pt")), pointerContent);
  const fourth = await publisher.publishWorkspaceFiles({files: []});
  assert.deepEqual(fourth.manifest.tombstones, ["renamed.pt"]);
  assert.equal(storage.objects.has(`${config.bucketName}/${blob}`), true, "deletion must retain historical data");
});

test("workspace install tree publishes concurrently and restores executable links and libraries", async (t) => {
  const {createAgentCheckpointRestoreService} = require("./agentCheckpointRestore.service");
  const {createWorkspacePathHelpers} = require("./workspacePath.helpers");
  const {execFileSync} = require("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-checkpoint-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root, {workspaceSyncPolicyExclude: []});
  const bin = path.join(config.workspaceDir, ".local/bin");
  const lib = path.join(config.workspaceDir, ".local/lib");
  await fs.mkdir(bin, {recursive: true});
  await fs.mkdir(lib, {recursive: true});
  await fs.writeFile(path.join(lib, "tool"), '#!/bin/sh\ncat "$(dirname "$0")/../lib/data-0"\n', {mode: 0o755});
  await fs.symlink("../lib/tool", path.join(bin, "tool"));
  for (let i = 0; i < 25; i++) await fs.writeFile(path.join(lib, `data-${i}`), "installed\n");
  const store = admittedStore();
  const storage = createStorage();
  const publisher = createAgentCheckpointService({admin, config, db: store.db, storage});
  const {shouldIgnoreWorkspacePath} = createWorkspacePathHelpers({config});
  const saved = await publisher.publishWorkspaceFiles({shouldIgnore: shouldIgnoreWorkspacePath});
  assert.equal(saved.manifest.files.length, 27);
  await fs.rm(config.workspaceDir, {recursive: true});
  await fs.mkdir(config.workspaceDir);
  const restore = createAgentCheckpointRestoreService({config, db: store.db, storage});
  await restore.restoreCheckpoint({shouldIgnore: shouldIgnoreWorkspacePath});
  assert.equal(await fs.readlink(path.join(bin, "tool")), "../lib/tool");
  assert.equal(execFileSync(path.join(bin, "tool"), {encoding: "utf8"}), "installed\n");
});

test("npm workspace install preserves node_modules, nested dependencies and executable links across two restarts", async (t) => {
  const {createAgentCheckpointRestoreService} = require("./agentCheckpointRestore.service");
  const {createWorkspacePathHelpers} = require("./workspacePath.helpers");
  const {execFileSync} = require("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-checkpoint-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root, {workspaceSyncPolicyExclude: []});
  const bin = path.join(config.workspaceDir, ".local/bin");
  const lib = path.join(config.workspaceDir, ".local/lib/node_modules/tool");
  await fs.mkdir(bin, {recursive: true});
  await fs.mkdir(lib, {recursive: true});
  await fs.writeFile(path.join(lib, "tool"), '#!/bin/sh\ncat "$(dirname "$0")/../lib/node_modules/tool/data-0"\n', {mode: 0o755});
  await fs.symlink("../lib/node_modules/tool/tool", path.join(bin, "tool"));
  for (let i = 0; i < 25; i++) await fs.writeFile(path.join(lib, `data-${i}`), "installed\n");
  await fs.mkdir(path.join(lib, "node_modules/dependency"), {recursive: true});
  await fs.writeFile(path.join(lib, "node_modules/dependency/index.js"), "nested dependency");
  const store = admittedStore();
  const storage = createStorage();
  const publisher = createAgentCheckpointService({admin, config, db: store.db, storage});
  const {shouldIgnoreWorkspacePath} = createWorkspacePathHelpers({config});
  const saved = await publisher.publishWorkspaceFiles({shouldIgnore: shouldIgnoreWorkspacePath});
  assert.equal(saved.manifest.files.length, 28);
  for (let restart = 0; restart < 2; restart++) {
    await fs.rm(config.workspaceDir, {recursive: true});
    await fs.mkdir(config.workspaceDir);
    const restore = createAgentCheckpointRestoreService({config, db: store.db, storage});
    await restore.restoreCheckpoint({shouldIgnore: shouldIgnoreWorkspacePath});
    assert.equal(await fs.readlink(path.join(bin, "tool")), "../lib/node_modules/tool/tool");
    assert.equal(execFileSync(path.join(bin, "tool"), {encoding: "utf8"}), "installed\n");
    assert.equal(await fs.readFile(path.join(lib, "node_modules/dependency/index.js"), "utf8"), "nested dependency");
    await publisher.publishWorkspaceFiles({shouldIgnore: shouldIgnoreWorkspacePath});
  }
});

test("a failed parallel installation upload never publishes a partial manifest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-checkpoint-failure-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  const store = admittedStore();
  const storage = createStorage({failOnUploadNumber: 3});
  const publisher = createAgentCheckpointService({admin, config, db: store.db, storage});
  await assert.rejects(publisher.publishWorkspaceFiles({
    files: Array.from({length: 129}, (_, i) => ({path: `src/tool-${i}`, content: "tool"})),
  }), /injected upload failure/);
  assert.equal(store.workspace.agentRuntimeWorkspaceFiles, undefined);
  assert.equal([...storage.objects.keys()].some((key) => key.endsWith("/manifest.json")), false);
  assert.equal(storage.uploads.length, 63);
});

test("capture rejects a symlink into excluded files before uploading or publishing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "excluded-tool-checkpoint-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root, {workspaceSyncPolicyExclude: [".local/lib"]});
  await fs.mkdir(path.join(config.workspaceDir, ".local/bin"), {recursive: true});
  await fs.mkdir(path.join(config.workspaceDir, ".local/lib"), {recursive: true});
  await fs.writeFile(path.join(config.workspaceDir, ".local/lib/tool"), "tool");
  await fs.symlink("../lib/tool", path.join(config.workspaceDir, ".local/bin/tool"));
  const store = admittedStore();
  const storage = createStorage();
  const publisher = createAgentCheckpointService({admin, config, db: store.db, storage});
  const {shouldIgnoreWorkspacePath} = require("./workspacePath.helpers").createWorkspacePathHelpers({config});
  await assert.rejects(publisher.publishWorkspaceFiles({shouldIgnore: shouldIgnoreWorkspacePath}),
      (error) => error.code === "checkpoint_unsafe_symlink");
  assert.equal(store.workspace.agentRuntimeWorkspaceFiles, undefined);
  assert.equal(storage.uploads.length, 0);
});

test("bundle upload failure never publishes and corrupt bundles never replace the live workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-failure-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  const store = admittedStore();
  const failedStorage = createStorage({failOnUploadNumber: 1});
  const files = [{path: ".local/bin/tool", content: "saved tool"}];
  await assert.rejects(createAgentCheckpointService({admin, config, db: store.db, storage: failedStorage})
      .publishWorkspaceFiles({files}), /injected upload failure/);
  assert.equal(store.workspace.agentRuntimeWorkspaceFiles, undefined);
  const storage = createStorage();
  const saved = await createAgentCheckpointService({admin, config, db: store.db, storage}).publishWorkspaceFiles({files});
  assert.equal(saved.manifest.files[0].storage, "workspace-bundle-v1");
  const bundlePath = saved.manifest.files[0].bundle.objectPath;
  storage.objects.set(`${config.bucketName}/${bundlePath}`, Buffer.from("corrupted!"));
  await fs.mkdir(config.workspaceDir);
  await fs.writeFile(path.join(config.workspaceDir, "sentinel"), "keep");
  const restore = require("./agentCheckpointRestore.service").createAgentCheckpointRestoreService({config, db: store.db, storage});
  await assert.rejects(restore.restoreWorkspaceFiles(), {code: "checkpoint_checksum_mismatch"});
  assert.equal(await fs.readFile(path.join(config.workspaceDir, "sentinel"), "utf8"), "keep");
});
