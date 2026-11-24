"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  recordVmUsageInTransaction,
  retainedDiskSizeGb,
  vmBackgroundUsageEntry,
  vmUsageEntry,
  vmUsageLedgerId,
} = require("./vmUsage.service");

test("VM usage separates active runtime from retained disk time", () => {
  const entry = vmUsageEntry({
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    generation: 2,
    operationId: "operation-1",
    workspace: {createdAtMs: 1_000, retainedStorageAccruedAtMs: 2_000, retainedDiskSizeGb: 64},
    session: {runtimeStartedAt: 3_000},
    endedAtMs: 7_000,
  });

  assert.equal(entry.runtimeSeconds, 4);
  assert.equal(entry.vmRuntimeSeconds, 4);
  assert.equal(entry.retainedStorageGbSeconds, 320);
  assert.equal(entry.retainedStorageKnown, true);
  assert.equal(entry.startedAt, 2_000);
  assert.equal(entry.runtimeStartedAt, 3_000);
});

test("starting a stopped VM accrues storage without replaying old runtime", () => {
  const entry = vmUsageEntry({
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    generation: 2,
    operationId: "operation-2",
    workspace: {retainedStorageAccruedAtMs: 2_000, retainedDiskSizeGb: 128},
    session: {runtimeStartedAt: 1_000},
    endedAtMs: 7_000,
    includeActiveRuntime: false,
  });

  assert.equal(entry.runtimeSeconds, 0);
  assert.equal(entry.vmRuntimeSeconds, 0);
  assert.equal(entry.retainedStorageGbSeconds, 640);
});

test("missing VM disk capacity is represented as unknown rather than zero capacity", () => {
  const entry = vmUsageEntry({
    workspaceId: "workspace-1", ownerUid: "owner-1", generation: 1, operationId: "operation-unknown",
    workspace: {retainedStorageAccruedAtMs: 1_000}, session: {}, endedAtMs: 2_000,
    includeActiveRuntime: false,
  });
  assert.equal(entry.retainedStorageGbSeconds, 0);
  assert.equal(entry.retainedStorageKnown, false);
});

test("background VM automation has its own duration and no allocated-runtime total", () => {
  const entry = vmBackgroundUsageEntry({
    executionRoute: "vm-native-v1",
    executionStartedAt: 2_000,
    completedAt: 5_000,
    status: "succeeded",
  }, 9_000);

  assert.equal(entry.runtimeSeconds, 0);
  assert.equal(entry.backgroundRuntimeSeconds, 3);
  assert.equal(entry.backgroundRunCount, 1);
  assert.equal(vmBackgroundUsageEntry({executionRoute: "shared-runtime-v1", startedAt: 1_000}, 9_000), null);
});

test("VM ledger identity is operation-scoped and disk size never accepts arbitrary values", () => {
  assert.equal(vmUsageLedgerId("workspace-1", "operation-1"), "vm-workspace-1-operation-1");
  assert.equal(retainedDiskSizeGb({retainedDiskSizeGb: 128}), 128);
  assert.equal(retainedDiskSizeGb({retainedDiskSizeGb: "bad", machineConfig: {desired: {diskSizeGb: 256}}}), 256);
  assert.equal(retainedDiskSizeGb({retainedDiskSizeGb: 9}), null);
  assert.throws(() => vmUsageLedgerId("../workspace", "operation-1"), /invalid_vm_usage_identity/);
});

test("recordVmUsageInTransaction is idempotent for a retried lifecycle operation", async () => {
  const docs = new Map();
  const ref = path => ({path, collection: name => ref(`${path}/${name}`), doc: name => ref(`${path}/${name}`)});
  const db = {collection: name => ref(name)};
  const tx = {
    get: async target => ({exists: docs.has(target.path), data: () => docs.get(target.path)}),
    set: (target, value) => docs.set(target.path, structuredClone(value)),
    update: (target, value) => docs.set(target.path, {...(docs.get(target.path) || {}), ...structuredClone(value)}),
  };
  const workspaceRef = ref("vmRuntimes_v2/workspace-1");
  const sessionRef = ref("vmRuntimes_v2/workspace-1/sessions/session-1");
  const input = {db, tx, workspaceRef, sessionRef, workspaceId: "workspace-1", ownerUid: "owner-1",
    generation: 1, operationId: "operation-1", workspace: {createdAtMs: 1_000, retainedStorageAccruedAtMs: 1_000, retainedDiskSizeGb: 64},
    session: {runtimeStartedAt: 1_000}, endedAtMs: 2_000};

  assert.equal((await recordVmUsageInTransaction(input)).recorded, true);
  assert.equal((await recordVmUsageInTransaction(input)).reason, "already_recorded");
  assert.equal(docs.get("users/owner-1/sessionUsage/vm-workspace-1-operation-1").runtimeSeconds, 1);
  assert.equal(docs.get(workspaceRef.path).retainedStorageAccruedAtMs, 2_000);
});
