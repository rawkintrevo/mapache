"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {agentSnapshotStoragePrefix} = require("./agentSnapshot.service");
const {createAgentCheckpointRestoreService} = require("./agentCheckpointRestore.service");

function hash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function configFor(root) {
  return {
    agentRuntimeEnabled: true,
    agentRuntimeGeneration: "7",
    agentUiVersion: "pi-web-ui-v1",
    bucketName: "workspace-bucket",
    internalStorageDir: ".mapache-internal",
    piAgentDir: path.join(root, "state", "pi"),
    piSessionDir: path.join(root, "state", "sessions"),
    piWebUiDataDir: path.join(root, "state", "ui"),
    prefix: "users/u/workspaces/workspace-1",
    sessionId: "session-1",
    workspaceDir: path.join(root, "workspace"),
    workspaceId: "workspace-1",
  };
}

function createStore(config, workspaceFields = {}) {
  const workspace = {workspaceId: config.workspaceId, ...workspaceFields};
  const workspaceRef = {
    async get() {
      return {exists: true, data: () => workspace};
    },
  };
  return {
    db: {
      collection(name) {
        assert.equal(name, "workspaces");
        return {doc: (id) => {
          assert.equal(id, config.workspaceId);
          return workspaceRef;
        }};
      },
    },
    workspace,
  };
}

function createStorage() {
  const objects = new Map();
  return {
    bucket(bucketName) {
      return {
        file(objectPath) {
          const key = `${bucketName}/${objectPath}`;
          return {
            async download() {
              if (!objects.has(key)) throw Object.assign(new Error("missing object"), {code: 404});
              return [objects.get(key)];
            },
          };
        },
      };
    },
    put(bucketName, objectPath, content) {
      const body = Buffer.from(content);
      objects.set(`${bucketName}/${objectPath}`, body);
      return {
        bucketName,
        objectPath,
        byteLength: body.length,
        sha256: hash(body),
      };
    },
  };
}

function manifestEntry({basePath, kind, path: relativePath, content, mode = 0o600, target}) {
  const entry = {path: relativePath, kind, mode};
  if (target !== undefined) {
    entry.target = target;
    entry.byteLength = Buffer.byteLength(target);
    entry.sha256 = hash(Buffer.from(target));
    return entry;
  }
  const body = Buffer.from(content);
  entry.byteLength = body.length;
  entry.sha256 = hash(body);
  entry.objectPath = `${basePath}/objects/${relativePath}`;
  return entry;
}

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-restore-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  await Promise.all([
    fs.mkdir(config.workspaceDir, {recursive: true}),
    fs.mkdir(config.piAgentDir, {recursive: true}),
    fs.mkdir(config.piSessionDir, {recursive: true}),
    fs.mkdir(config.piWebUiDataDir, {recursive: true}),
  ]);
  await fs.mkdir(path.join(config.workspaceDir, ".git"), {recursive: true});
  await fs.writeFile(path.join(config.workspaceDir, ".git", "preserve-me"), "archive state");
  await fs.writeFile(path.join(config.workspaceDir, "old.txt"), "old workspace");
  await fs.writeFile(path.join(config.piAgentDir, "old-settings.json"), "old settings");
  await fs.writeFile(path.join(config.piSessionDir, "old.jsonl"), "{\"old\":true}\n");
  await fs.writeFile(path.join(config.piWebUiDataDir, "old-state.json"), "old ui");

  const storage = createStorage();
  const namespace = agentSnapshotStoragePrefix(config);
  const agentBase = `${namespace}/5/boot-old/capture-old`;
  const workspaceBase = `${namespace}/workspace-files/5/boot-old/workspace-old`;
  const agentContents = {
    "sessions/chat.jsonl": Buffer.from("{\"type\":\"session\"}\n{\"type\":\"message\"}\n"),
    "pi/settings.json": Buffer.from("{\"theme\":\"dark\"}\n"),
    "ui/client-state.json": Buffer.from("{\"active\":\"chat\"}\n"),
    "uploads/client-1/note.txt": Buffer.from("attachment\n"),
  };
  const agentFiles = Object.entries(agentContents).map(([relativePath, content]) => {
    const kind = relativePath.startsWith("sessions/") ? "pi-transcript" : relativePath.startsWith("pi/") ? "pi-setting" : relativePath.startsWith("ui/") ? "ui-state" : "attachment";
    const entry = manifestEntry({basePath: agentBase, content, kind, path: relativePath, mode: 0o640});
    storage.put(config.bucketName, entry.objectPath, content);
    if (kind === "pi-transcript") {
      entry.completeRecords = true;
      entry.recordCount = 2;
    }
    return entry;
  });
  const agentLink = manifestEntry({kind: "symlink", mode: 0o777, path: "ui/shortcut.json", target: "client-state.json"});
  agentFiles.push(agentLink);
  const agentManifest = {
    manifestVersion: 1,
    kind: "mapache-agent-state-snapshot",
    storagePrefix: namespace,
    workspaceId: config.workspaceId,
    sessionId: config.sessionId,
    generation: 5,
    bootInstanceId: "boot-old",
    capturedAt: "2026-09-11T12:00:00.000Z",
    files: agentFiles,
  };
  const agentManifestRef = storage.put(config.bucketName, `${agentBase}/manifest.json`, JSON.stringify(agentManifest));

  const workspaceContents = {"nested/.hidden": Buffer.from("restored workspace\n")};
  const workspaceFiles = Object.entries(workspaceContents).map(([relativePath, content]) => {
    const entry = manifestEntry({basePath: workspaceBase, content, kind: "workspace-file", path: relativePath, mode: 0o640});
    storage.put(config.bucketName, entry.objectPath, content);
    return entry;
  });
  const workspaceLink = manifestEntry({kind: "symlink", mode: 0o777, path: "current.txt", target: "nested/.hidden"});
  workspaceFiles.push(workspaceLink);
  const workspaceManifest = {
    manifestVersion: 1,
    kind: "mapache-workspace-file-state",
    storagePrefix: namespace,
    workspaceId: config.workspaceId,
    sessionId: config.sessionId,
    generation: 5,
    bootInstanceId: "boot-old",
    capturedAt: "2026-09-11T12:00:01.000Z",
    files: workspaceFiles,
    tombstones: ["old.txt"],
  };
  const workspaceManifestRef = storage.put(config.bucketName, `${workspaceBase}/manifest.json`, JSON.stringify(workspaceManifest));
  const store = createStore(config, {
    agentRuntimeCheckpoint: {
      captureId: "capture-old",
      generation: 5,
      bootInstanceId: "boot-old",
      fileCount: agentFiles.length,
      manifest: agentManifestRef,
    },
    agentRuntimeWorkspaceFiles: {
      captureId: "workspace-old",
      generation: 5,
      bootInstanceId: "boot-old",
      fileCount: workspaceFiles.length,
      tombstoneCount: 1,
      manifest: workspaceManifestRef,
    },
  });
  return {agentManifest, config, root, storage, store, workspaceManifest};
}

test("restores workspace files, history, settings, UI state, attachments, and safe links atomically", async (t) => {
  const {config, storage, store} = await makeFixture(t);
  const restore = createAgentCheckpointRestoreService({config, db: store.db, storage});

  const result = await restore.restoreCheckpoint({
    shouldIgnore: (relativePath) => relativePath === ".git" || relativePath.startsWith(".git/"),
  });

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(config.workspaceDir, "nested/.hidden"), "utf8"), "restored workspace\n");
  assert.equal(await fs.readlink(path.join(config.workspaceDir, "current.txt")), "nested/.hidden");
  await assert.rejects(fs.lstat(path.join(config.workspaceDir, "old.txt")), {code: "ENOENT"});
  assert.equal(await fs.readFile(path.join(config.workspaceDir, ".git/preserve-me"), "utf8"), "archive state");
  assert.equal(await fs.readFile(path.join(config.piSessionDir, "chat.jsonl"), "utf8"), "{\"type\":\"session\"}\n{\"type\":\"message\"}\n");
  assert.equal(await fs.readFile(path.join(config.piAgentDir, "settings.json"), "utf8"), "{\"theme\":\"dark\"}\n");
  assert.equal(await fs.readFile(path.join(config.piWebUiDataDir, "client-state.json"), "utf8"), "{\"active\":\"chat\"}\n");
  assert.equal(await fs.readFile(path.join(config.piWebUiDataDir, "uploads/client-1/note.txt"), "utf8"), "attachment\n");
  assert.equal(await fs.readlink(path.join(config.piWebUiDataDir, "shortcut.json")), "client-state.json");
});

test("does not partially replace good local state when a published object is corrupt or missing", async (t) => {
  const {config, storage, store} = await makeFixture(t);
  const pointer = store.workspace.agentRuntimeWorkspaceFiles;
  const corruptPath = `${agentSnapshotStoragePrefix(config)}/workspace-files/5/boot-old/workspace-old/objects/nested/.hidden`;
  storage.put(config.bucketName, corruptPath, "wrong bytes");
  const restore = createAgentCheckpointRestoreService({config, db: store.db, storage});

  await assert.rejects(restore.restoreWorkspaceFiles(), (error) => error.code === "checkpoint_checksum_mismatch");
  assert.equal(await fs.readFile(path.join(config.workspaceDir, "old.txt"), "utf8"), "old workspace");
  assert.equal(await fs.readFile(path.join(config.workspaceDir, ".git/preserve-me"), "utf8"), "archive state");
  assert.deepEqual(store.workspace.agentRuntimeWorkspaceFiles, pointer);
});

test("rejects mixed-generation manifests before changing any target", async (t) => {
  const {config, storage, store} = await makeFixture(t);
  const pointer = store.workspace.agentRuntimeCheckpoint;
  const manifestPath = pointer.manifest.objectPath;
  const mismatched = {
    manifestVersion: 1,
    kind: "mapache-agent-state-snapshot",
    storagePrefix: agentSnapshotStoragePrefix(config),
    workspaceId: config.workspaceId,
    sessionId: config.sessionId,
    generation: 6,
    bootInstanceId: "boot-old",
    capturedAt: "2026-09-11T12:00:00.000Z",
    files: [],
  };
  pointer.manifest = storage.put(config.bucketName, manifestPath, JSON.stringify(mismatched));
  await assert.rejects(
      createAgentCheckpointRestoreService({config, db: store.db, storage}).restoreAgentState(),
      (error) => error.code === "checkpoint_generation_mismatch",
  );
  assert.equal(await fs.readFile(path.join(config.piAgentDir, "old-settings.json"), "utf8"), "old settings");
});

test("rejects unsafe workspace links before changing any target", async (t) => {
  const {config, storage, store, workspaceManifest} = await makeFixture(t);
  workspaceManifest.files.push(manifestEntry({
    kind: "symlink",
    mode: 0o777,
    path: "unsafe.txt",
    target: "../outside.txt",
  }));
  const pointer = store.workspace.agentRuntimeWorkspaceFiles;
  pointer.fileCount = workspaceManifest.files.length;
  pointer.manifest = storage.put(
      config.bucketName,
      pointer.manifest.objectPath,
      `${JSON.stringify(workspaceManifest)}\n`,
  );
  const restore = createAgentCheckpointRestoreService({config, db: store.db, storage});

  await assert.rejects(
      restore.restoreWorkspaceFiles(),
      (error) => error.code === "checkpoint_unsafe_symlink",
  );
  assert.equal(await fs.readFile(path.join(config.workspaceDir, "old.txt"), "utf8"), "old workspace");
  await assert.rejects(fs.lstat(path.join(config.workspaceDir, "unsafe.txt")), {code: "ENOENT"});
});

test("new workspaces with no published checkpoint remain empty and restore makes no model request", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-agent-empty-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = configFor(root);
  const store = createStore(config);
  const restore = createAgentCheckpointRestoreService({config, db: store.db, storage: createStorage()});
  let modelRequests = 0;

  const result = await restore.restoreCheckpoint({onModelRequest: () => modelRequests++});

  assert.deepEqual(result, {ok: true, skipped: true, reason: "no_published_checkpoint"});
  assert.equal(modelRequests, 0);
  assert.equal(await fs.access(config.workspaceDir).then(() => true).catch(() => false), false);
});
