"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {isIdleVmWorkspace, reconcileIdleVmWorkspaces} = require("./vmIdleReconcile.service");

const now = 10_000_000;
const workspace = {ownerUid: "owner", backend: "compute-engine", lifecycleEnabled: true,
  state: "active", generation: 3, currentSessionId: "session",
  machineConfig: {desired: {idleStopMinutes: 5}}};

test("idle VM policy requires an old activity signal and no open sockets", () => {
  assert.equal(isIdleVmWorkspace(workspace, {state: "active", generation: 3,
    runtimeStartedAt: now - 6 * 60 * 1000, lastActivityAt: now - 6 * 60 * 1000}, () => now), true);
  assert.equal(isIdleVmWorkspace(workspace, {state: "active", generation: 3,
    runtimeStartedAt: now - 6 * 60 * 1000, lastActivityAt: now - 6 * 60 * 1000, activeSocketCount: 1}, () => now), false);
  assert.equal(isIdleVmWorkspace({...workspace, machineConfig: {desired: {}}},
    {state: "active", generation: 3, runtimeStartedAt: now - 60 * 60 * 1000}, () => now), false);
});

test("idle reconciliation requests one idempotent pause per stale VM", async () => {
  const docs = [{id: "idle", data: () => workspace}, {id: "busy", data: () => workspace}];
  const sessions = {
    idle: {state: "active", generation: 3, runtimeStartedAt: now - 6 * 60 * 1000, lastActivityAt: now - 6 * 60 * 1000},
    busy: {state: "active", generation: 3, runtimeStartedAt: now - 6 * 60 * 1000, lastActivityAt: now - 6 * 60 * 1000, activeSocketCount: 1},
  };
  const firestore = {collection: () => ({limit: () => ({get: async () => ({docs})}), doc: id => ({collection: () => ({doc: () => ({get: async () => ({data: () => sessions[id]})})})})})};
  const requests = [];
  const result = await reconcileIdleVmWorkspaces({firestore, now: () => now, lifecycle: {
    request: async request => { requests.push(request); return {operationId: "operation"}; },
  }});
  assert.equal(result.scanned, 2);
  assert.equal(result.requested, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(requests, [{workspaceId: "idle", ownerUid: "owner", action: "pause", expectedGeneration: 3,
    requestId: "idle-166"}]);
});
