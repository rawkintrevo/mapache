"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CHUNK_RECORD_LIMIT,
  createAutomationArtifactsService,
} = require("./automationArtifacts.service");

class FileRef {
  constructor(storage, bucket, name) {
    this.storage = storage;
    this.bucket = bucket;
    this.name = name;
  }

  async save(content, options = {}) {
    const key = `${this.bucket}/${this.name}`;
    if (options.ifGenerationMatch === 0 && this.storage.objects.has(key)) {
      const error = new Error("already exists");
      error.code = 412;
      throw error;
    }
    this.storage.objects.set(key, {
      content: Buffer.from(content),
      metadata: options.metadata?.metadata || {},
      generation: String(this.storage.objects.size + 1),
    });
  }

  async download() {
    const object = this.storage.objects.get(`${this.bucket}/${this.name}`);
    if (!object) {
      const error = new Error("missing");
      error.code = 404;
      throw error;
    }
    return [Buffer.from(object.content)];
  }
}

class Storage {
  constructor() {
    this.objects = new Map();
  }

  bucket(name) {
    return {file: (path) => new FileRef(this, name, path)};
  }
}

class Ref {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }

  async get() {
    const value = this.db.data.get(this.path);
    return {exists: value !== undefined, id: this.id, data: () => value};
  }

  collection(name) {
    return new Collection(this.db, `${this.path}/${name}`);
  }
}

class Collection {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id) {
    return new Ref(this.db, `${this.path}/${id}`, id);
  }
}

class Db {
  constructor() {
    this.data = new Map();
  }

  collection(name) {
    return new Collection(this, name);
  }

  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: (ref) => ref.get(),
      update: (ref, value) => writes.push({ref, value}),
    };
    const result = await callback(transaction);
    writes.forEach(({ref, value}) => this.data.set(ref.path, {...(this.data.get(ref.path) || {}), ...value}));
    return result;
  }
}

function setup() {
  const storage = new Storage();
  const db = new Db();
  db.data.set("workspaces/workspace-1", {ownerUid: "user-1"});
  db.data.set("workspaces/workspace-1/sessions/auto-run-1", {
    runtimeKind: "automation",
    automationRunId: "run-1",
    runnerSessionId: "auto-run-1",
    agentRuntimeGeneration: 4,
    agentRuntimeBootInstanceId: "boot-1",
  });
  db.data.set("automationRuns/run-1", {ownerUid: "user-1", status: "running"});
  const admin = {firestore: {FieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"}}};
  const config = {
    agentRuntimeEnabled: true,
    automationRunId: "run-1",
    bucketName: "bucket-1",
    prefix: "workspaces/workspace-1",
    runtimeKind: "automation",
    sessionId: "auto-run-1",
    workspaceId: "workspace-1",
  };
  return {admin, config, db, service: createAutomationArtifactsService({admin, config, db, storage}), storage};
}

test("captures immutable chunked events, transcript, summary, and publishes one authority pointer", async () => {
  const {config, db, service, storage} = setup();
  const result = await service.capture({
    bootInstanceId: "boot-1",
    generation: 4,
    events: Array.from({length: CHUNK_RECORD_LIMIT + 1}, (_, index) => ({type: "event", index})),
    transcript: [{role: "assistant", text: "done"}],
    summary: {outcome: "succeeded", finalText: "done"},
  });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.chunks.filter((chunk) => chunk.kind === "events").length, 2);
  assert.equal(result.manifest.summary.objectPath.includes("/automation-runs/run-1/v1/"), true);
  assert.equal(db.data.get("workspaces/workspace-1/sessions/auto-run-1").automationArtifactPointer.runId, "run-1");
  assert.equal(db.data.get("automationRuns/run-1").artifactPointers.automation.manifest.objectPath, result.pointer.manifest.objectPath);
  assert.equal([...storage.objects.keys()].some((key) => key.includes("manifest-")), true);
  assert.equal(config.runtimeKind, "automation");
});

test("partial uploads and stale boot identity never publish a pointer", async () => {
  const first = setup();
  let calls = 0;
  await assert.rejects(
      first.service.capture({
        bootInstanceId: "boot-1",
        generation: 4,
        events: [{type: "event"}],
        uploadObject: async () => {
          calls++;
          if (calls > 1) throw new Error("upload failed");
        },
      }),
      /upload failed/,
  );
  assert.equal(first.db.data.get("workspaces/workspace-1/sessions/auto-run-1").automationArtifactPointer, undefined);

  const stale = setup();
  stale.db.data.get("workspaces/workspace-1/sessions/auto-run-1").agentRuntimeBootInstanceId = "boot-new";
  await assert.rejects(
      stale.service.capture({bootInstanceId: "boot-1", generation: 4, events: [{type: "event"}]}),
      (error) => error.code === "automation_artifact_authority_stale",
  );
  assert.equal(stale.db.data.get("workspaces/workspace-1/sessions/auto-run-1").automationArtifactPointer, undefined);
});

test("rejects credentials and request metadata before writing artifact objects", async () => {
  const {service, storage} = setup();
  await assert.rejects(
      service.capture({bootInstanceId: "boot-1", generation: 4, events: [{authorization: "Bearer secret"}]}),
      (error) => error.code === "automation_artifact_sensitive_field",
  );
  assert.equal(storage.objects.size, 0);
});

test("rejects a malformed JSONL tail before writing any artifact", async () => {
  const {service, storage} = setup();
  await assert.rejects(
      service.capture({
        bootInstanceId: "boot-1",
        generation: 4,
        events: `${JSON.stringify({type: "started"})}\n{"type":"unfinished"`,
      }),
      (error) => error.code === "automation_artifact_jsonl_invalid",
  );
  assert.equal(storage.objects.size, 0);
});
