"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {createAutomationHistoryService} = require("./automationHistory.service");

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
}

class Query {
  constructor(db, path, filters = [], options = {}) {
    this.db = db;
    this.path = path;
    this.filters = filters;
    this.options = options;
  }

  where(field, operator, value) {
    return new Query(this.db, this.path, [...this.filters, {field, operator, value}], this.options);
  }

  orderBy(field, direction) {
    return new Query(this.db, this.path, this.filters, {...this.options, field, direction});
  }

  limit(value) {
    return new Query(this.db, this.path, this.filters, {...this.options, limit: value});
  }

  startAfter() {
    return this;
  }

  async get() {
    let entries = [...this.db.data.entries()]
        .filter(([path]) => path.startsWith(`${this.path}/`) && !path.slice(this.path.length + 1).includes("/"));
    entries = entries.filter(([, value]) => this.filters.every(({field, value: expected}) => value[field] === expected));
    if (this.options.field) entries.sort(([, left], [, right]) => String(right[this.options.field] || "").localeCompare(String(left[this.options.field] || "")));
    if (this.options.limit) entries = entries.slice(0, this.options.limit);
    return {docs: entries.map(([path, value]) => new Snapshot(new Ref(this.db, path, path.split("/").pop()), value))};
  }
}

class Snapshot {
  constructor(ref, value) {
    this.id = ref.id;
    this.ref = ref;
    this.exists = true;
    this._value = value;
  }

  data() {
    return this._value;
  }
}

class Db {
  constructor() {
    this.data = new Map();
  }

  collection(name) {
    return {
      doc: (id) => new Ref(this, `${name}/${id}`, id),
      where: (field, operator, value) => new Query(this, name, [{field, operator, value}]),
    };
  }
}

class Storage {
  constructor() {
    this.objects = new Map();
  }

  bucket(bucket) {
    return {file: (name) => ({download: async () => {
      const value = this.objects.get(`${bucket}/${name}`);
      if (!value) throw new Error("missing");
      return [Buffer.from(value)];
    }})};
  }
}

function reference(storage, objectPath, content) {
  const buffer = Buffer.from(content);
  storage.objects.set(`bucket-1/${objectPath}`, buffer);
  return {bucketName: "bucket-1", objectPath, byteLength: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex")};
}

function setup() {
  const db = new Db();
  const storage = new Storage();
  const records = Array.from({length: 205}, (_, index) => ({message: `event-${index}`}));
  const chunk = Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const summary = Buffer.from("{}\n");
  const manifest = {
    version: 1,
    kind: "mapache-automation-artifacts",
    runId: "run-1",
    workspaceId: "workspace-1",
    sessionId: "auto-run-1",
    generation: 2,
    bootInstanceId: "boot-1",
    capturedAt: "2026-09-20T10:00:00.000Z",
    chunks: [{kind: "events", ...reference(storage, "workspaces/workspace-1/automation-runs/run-1/v1/events/chunk.jsonl", chunk)}],
    summary: reference(storage, "workspaces/workspace-1/automation-runs/run-1/v1/summary/summary.json", summary),
    eventCount: records.length,
    transcriptCount: 0,
  };
  const manifestContent = `${JSON.stringify(manifest)}\n`;
  const pointer = {
    version: 1,
    kind: "mapache-automation-artifacts",
    runId: "run-1",
    workspaceId: "workspace-1",
    sessionId: "auto-run-1",
    generation: 2,
    bootInstanceId: "boot-1",
    manifest: reference(storage, "workspaces/workspace-1/automation-runs/run-1/v1/manifest.json", manifestContent),
  };
  db.data.set("automationRuns/run-1", {
    runId: "run-1", ownerUid: "user-1", workspaceId: "workspace-1", automationId: "automation-1",
    status: "succeeded", cleanupState: "complete", createdAt: "2026-09-20T10:00:00.000Z", artifactPointers: {automation: pointer},
  });
  db.data.set("automationRuns/run-2", {
    runId: "run-2", ownerUid: "user-1", workspaceId: "workspace-1", automationId: "automation-1",
    status: "failed", cleanupState: "complete", createdAt: "2026-09-20T09:00:00.000Z",
  });
  db.data.set("automationRuns/run-other", {
    runId: "run-other", ownerUid: "user-2", workspaceId: "workspace-1", status: "succeeded", createdAt: "2026-09-20T11:00:00.000Z",
  });
  return {db, service: createAutomationHistoryService({db, storage})};
}

test("history listing is owner scoped and bounded", async () => {
  const {service} = setup();
  const page = await service.listRuns("user-1", {limit: 1});
  assert.equal(page.runs.length, 1);
  assert.equal(page.runs[0].runId, "run-1");
  assert.equal(page.nextCursor !== null, true);
  assert.equal((await service.listRuns("user-2")).runs.length, 1);
  await assert.rejects(() => service.getRun("user-2", "run-1"), /automation_run_forbidden/);
});

test("artifact events are checksum verified and paged at 200 records", async () => {
  const {service} = setup();
  const first = await service.listEvents("user-1", "run-1");
  assert.equal(first.events.length, 200);
  assert.equal(first.nextCursor !== null, true);
  const second = await service.listEvents("user-1", "run-1", {cursor: first.nextCursor});
  assert.equal(second.events.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(second.events[0].record.message, "event-200");
});

test("artifact paths outside the run namespace are rejected", async () => {
  const {db, service} = setup();
  db.data.get("automationRuns/run-1").artifactPointers.automation.manifest.objectPath = "other/manifest.json";
  await assert.rejects(() => service.listEvents("user-1", "run-1"), /automation_artifact_invalid/);
});
