"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {createVmRuntimePolicyService} = require("./vmRuntimePolicy.service");

function fixture({state = "stopped", policy = {mode: "idle", schedule: null}, now = "2026-10-19T19:00:00.000Z"} = {}) {
  const docs = new Map();
  const workspace = {ownerUid: "owner", apiEnabled: true, lifecycleEnabled: true, backend: "compute-engine",
    generation: 2, state, currentSessionId: "session", runtimePolicy: policy, runtimePolicyRevision: 1,
    gatewayHost: "fixture.example.com", runnerImage: `us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:${"a".repeat(64)}`};
  docs.set("vmRuntimes_v2/machine", workspace);
  docs.set("vmRuntimes_v2/machine/sessions/session", {ownerUid: "owner", generation: 2, state: state === "active" ? "active" : "stopped"});
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const snapshot = path => ({exists: docs.has(path), data: () => clone(docs.get(path))});
  const ref = path => ({path, get: async () => snapshot(path), doc: id => ref(`${path}/${id}`), collection: id => ref(`${path}/${id}`)});
  const db = {
    collection: name => ({
      ...ref(name),
      limit: () => ({get: async () => ({docs: [...docs.entries()]
        .filter(([path]) => path.startsWith(`${name}/`) && path.split("/").length === 2)
        .map(([path, data]) => ({id: path.split("/").pop(), data: () => clone(data)}))})}),
    }),
    runTransaction: async callback => {
      const changes = [];
      const result = await callback({get: async target => snapshot(target.path), update: (target, updates) => {
        changes.push(() => docs.set(target.path, {...(docs.get(target.path) || {}), ...clone(updates)}));
      }});
      changes.forEach(apply => apply());
      return result;
    },
  };
  const requests = [];
  const lifecycle = {request: async request => {
    requests.push(request);
    docs.get("vmRuntimes_v2/machine").activeOperationId = "operation";
    return {operationId: "operation", status: "pending"};
  }};
  const service = createVmRuntimePolicyService({db, lifecycle, now: () => Date.parse(now)});
  return {docs, requests, service, workspace: () => docs.get("vmRuntimes_v2/machine"), callNow: () => Date.parse(now)};
}

test("VM runtime policy is owner- and generation-fenced and exposes only safe policy fields", async () => {
  const f = fixture();
  const result = await f.service.getWorkspaceRuntimePolicy({workspaceId: "machine", ownerUid: "owner"});
  assert.deepEqual(result.runtimePolicy, {mode: "idle", schedule: null});
  await assert.rejects(f.service.getWorkspaceRuntimePolicy({workspaceId: "machine", ownerUid: "other"}), /not_found/);
  await assert.rejects(f.service.updateWorkspaceRuntimePolicy({workspaceId: "machine", ownerUid: "owner",
    patch: {expectedGeneration: 1, mode: "keep-running"}}), /vm_generation_mismatch/);
  const updated = await f.service.updateWorkspaceRuntimePolicy({workspaceId: "machine", ownerUid: "owner",
    patch: {expectedGeneration: 2, mode: "keep-running", schedule: null}});
  assert.deepEqual(updated.runtimePolicy, {mode: "keep-running", schedule: null});
  assert.equal(f.workspace().runtimePolicyRevision, 2);
  assert.equal(f.docs.get("vmRuntimes_v2/machine/sessions/session").longRunning, true);
});

test("scheduled VMs request a start inside the window and a pause outside it", async () => {
  const schedule = {days: [1], startTime: "08:00", endTime: "18:00", timezone: "UTC"};
  const open = fixture({policy: {mode: "scheduled", schedule}, now: "2026-10-19T14:00:00.000Z"});
  const opened = await open.service.reconcileVmRuntimePolicy("machine", new Date(open.callNow()));
  assert.equal(opened.action, "start_requested");
  assert.equal(open.requests[0].action, "start");
  assert.equal(open.workspace().runtimeScheduleStatus, "open");
  assert.equal(open.workspace().runtimeScheduleNextEvent.action, "stop");

  const closed = fixture({state: "active", policy: {mode: "scheduled", schedule}, now: "2026-10-19T19:00:00.000Z"});
  const closedResult = await closed.service.reconcileVmRuntimePolicy("machine", new Date(closed.callNow()));
  assert.equal(closedResult.action, "pause_requested");
  assert.equal(closed.requests[0].action, "pause");
  assert.equal(closed.workspace().runtimeScheduleStatus, "closed");
  assert.equal(closed.workspace().runtimeScheduleNextEvent.action, "start");
});

test("enabling a schedule reconciles immediately and scan remains bounded to admitted VM records", async () => {
  const f = fixture({now: "2026-10-19T14:00:00.000Z"});
  const schedule = {days: [1], startTime: "08:00", endTime: "18:00", timezone: "UTC"};
  const updated = await f.service.updateWorkspaceRuntimePolicy({workspaceId: "machine", ownerUid: "owner",
    patch: {expectedGeneration: 2, mode: "scheduled", schedule}});
  assert.equal(updated.runtimePolicy.mode, "scheduled");
  assert.equal(f.requests[0].action, "start");
  const scan = await f.service.reconcileScheduledVmWorkspaces();
  assert.equal(scan.scanned, 1);
  assert.equal(scan.requested, 0, "the idempotent lifecycle request is not duplicated after the first tick");
});
