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
