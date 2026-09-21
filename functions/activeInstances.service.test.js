"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {listInstances} = require("./activeInstances.service");

class Doc {
  constructor(id, value) {
    this.id = id;
    this._value = value;
  }

  data() {
    return this._value;
  }
}

class Query {
  constructor(docs) {
    this.docs = docs;
  }

  where(field, operator, expected) {
    const values = Array.isArray(expected) ? expected : [expected];
    return new Query(this.docs.filter((doc) => {
      const value = doc.data()?.[field];
      return operator === "in" ? values.includes(value) : value === expected;
    }));
  }

  async get() {
    return {docs: this.docs};
  }
}

function setup() {
  const sessions = [
    new Doc("main-1", {
      ownerUid: "owner-a", workspaceId: "workspace-a", status: "running",
      resources: {cpu: "1", memory: "2Gi"}, runtimeStartedAt: "2026-09-20T12:00:00Z",
    }),
    new Doc("auto-run-1", {
      ownerUid: "owner-a", workspaceId: "workspace-a", runtimeKind: "automation",
      automationRunId: "run-1", status: "running", runtimeStartedAt: "2026-09-20T12:02:00Z",
    }),
    new Doc("other-owner", {
      ownerUid: "owner-b", workspaceId: "workspace-b", status: "running",
      runtimeStartedAt: "2026-09-20T13:00:00Z",
    }),
  ];
  const runs = [
    new Doc("run-1", {
      ownerUid: "owner-a", workspaceId: "workspace-a", sessionId: "auto-run-1",
      status: "running", startedAt: "2026-09-20T12:02:01Z", updatedAt: "2026-09-20T12:04:00Z",
      snapshot: {resources: {cpu: "2", memory: "4Gi"}},
    }),
    new Doc("run-cleanup", {
      ownerUid: "owner-a", workspaceId: "workspace-b", status: "failed", cleanupState: "error",
      createdAt: "2026-09-20T12:03:00Z", updatedAt: "2026-09-20T12:05:00Z",
    }),
  ];
  return {
    collectionGroup: () => new Query(sessions),
    collection: () => ({
      where: (field, operator, expected) => new Query(runs).where(field, operator, expected),
    }),
  };
}

test("lists owner-scoped main and automation instances without duplicate automation sessions", async () => {
  const result = await listInstances("owner-a", {limit: 10}, {db: setup()});
  assert.deepEqual(result.instances.map((instance) => [instance.type, instance.runId, instance.status]), [
    ["automation", "run-cleanup", "cleanup-error"],
    ["automation", "run-1", "running"],
    ["main", null, "running"],
  ]);
  assert.deepEqual(result.instances[1].resources, {cpu: "2", memory: "4Gi"});
  assert.deepEqual(result.instances[1].stopTarget, {
    type: "automation-run", workspaceId: "workspace-a", runId: "run-1", sessionId: "auto-run-1",
  });
});

test("supports stable cursor pagination and workspace filters", async () => {
  const db = setup();
  const first = await listInstances("owner-a", {limit: 1, workspaceId: "workspace-a"}, {db});
  assert.equal(first.instances.length, 1);
  assert.ok(first.nextCursor);
  const second = await listInstances("owner-a", {
    limit: 10, workspaceId: "workspace-a", cursor: first.nextCursor,
  }, {db});
  assert.deepEqual(second.instances.map((instance) => instance.runId), [null]);
});

test("rejects invalid filters and cursor ownership", async () => {
  await assert.rejects(() => listInstances("owner-a", {status: "succeeded"}, {db: setup()}), /invalid_instance_status/);
  const cursor = Buffer.from(JSON.stringify({
    version: 1, ownerUid: "owner-b", sort: "startedAt_desc_instanceKey_desc",
    startedAt: "2026-09-20T12:00:00Z", instanceKey: "main:workspace-a:main-1",
    workspaceId: "", type: "", status: "",
  }), "utf8").toString("base64url");
  await assert.rejects(() => listInstances("owner-a", {cursor}, {db: setup()}), /invalid_instance_cursor/);
});

console.log("active instance service tests passed");
