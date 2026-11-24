"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {buildInventoryReport, createVmBackupInventoryService, estimatedCost} = require("./vmBackupInventory.service");

const NOW = Date.parse("2026-01-10T00:00:00.000Z");

test("inventory reports backup age, stranded state, retention decisions, and unknown cost components", () => {
  const report = buildInventoryReport({workspaceId: "workspace-1", ownerUid: "owner-1", observedAtMs: NOW,
    runtime: {backupPolicy: {enabled: true, schedule: "daily"}},
    providerResources: {instances: [{name: "unexpected-instance", status: "TERMINATED"}],
      disks: [{name: "mapache-disk-workspace-1", status: "READY", sizeGb: 64, users: []}]},
    compute: {disk: {status: "READY", sizeGb: 64, users: []}, instance: null},
    snapshots: [
      {name: "verified", workspaceId: "workspace-1", ownerUid: "owner-1", state: "verified",
        verification: {state: "verified", verifiedAt: "2026-01-09T00:00:00.000Z"},
        retention: {expiresAt: "2026-01-01T00:00:00.000Z"}},
      {name: "foreign", workspaceId: "workspace-1", ownerUid: "other", state: "verified"},
    ]});
  assert.equal(report.strandedResources.diskWithoutInstance, true);
  assert.equal(report.backups.backupAgeMs, 24 * 60 * 60 * 1000);
  assert.deepEqual(report.backups.retentionCandidates.map(item => item.name), ["verified"]);
  assert.deepEqual(report.backups.quarantined.map(item => item.name), ["foreign"]);
  assert.equal(report.strandedResources.cleanupAllowed, false);
  assert.equal(report.providerResources.known, true);
  assert.deepEqual(report.strandedResources.unexpectedOwnedInstances, ["unexpected-instance"]);
  assert.equal(report.strandedResources.ownedDiskCount, 1);
  assert.equal(report.cost.retainedStorageMonthlyUsd, 6.4);
  assert.ok(report.cost.unknownComponents.includes("network"));
  assert.ok(report.cost.unknownComponents.includes("compute"));
});

test("inventory service only reports explicitly opted-in runtimes", async () => {
  const db = memoryDb();
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "workspace-1", ownerUid: "owner-1"});
  db.seed("vmRuntimes_v2/workspace-1", {ownerUid: "owner-1", backend: "compute-engine", runtimeProvider: descriptor,
    backupPolicy: {enabled: true}});
  db.seed("vmBackups_v2/workspace-1/items/backup-1", {name: "snapshot-1", workspaceId: "workspace-1", ownerUid: "owner-1",
    state: "verified", verification: {state: "verified"}});
  db.seed("vmRuntimes_v2/workspace-2", {ownerUid: "owner-2", backend: "compute-engine", runtimeProvider: descriptor,
    backupPolicy: {enabled: false}});
  const calls = [];
  const service = createVmBackupInventoryService({db, now: () => NOW, provider: {
    inspect: async () => ({disk: {sizeGb: 10, users: []}, instance: null}),
    listOwnedResources: async () => ({instances: [], disks: []}),
    listSnapshots: async () => [],
  }});
  const result = await service.runTick();
  assert.deepEqual(result, {checked: 2, reported: 1, skipped: 1, failed: 0});
  assert.equal(db.docs("vmBackupInventoryReports_v2").length, 1);
  assert.equal(calls.length, 0);
});

test("cost estimates never turn missing compute rates or invalid values into false precision", () => {
  assert.deepEqual(estimatedCost({diskGiB: "bad", snapshotGiB: 2, computeHourlyRate: null}), {
    retainedStorageMonthlyUsd: 0,
    snapshotStorageMonthlyUsd: 0.13,
    computeMonthlyUsd: null,
    totalKnownMonthlyUsd: 0.13,
    ratesAreEstimates: true,
    unknownComponents: ["network", "gateway", "nat", "compute"],
    assumptions: {diskRate: 0.1, snapshotRate: 0.065, computeHourlyRate: null, activeHours: 0, instanceRunning: false},
  });
});

function memoryDb() {
  const values = new Map();
  const db = {
    collection: name => collection(name),
    seed(path, value) { values.set(path, clone(value)); },
    docs(path) { return [...values.entries()].filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")); },
  };
  return db;
  function collection(path) {
    return {
      doc: id => doc(`${path}/${id}`),
      where: (field, operator, value) => ({limit: () => ({get: async () => ({docs: db.docs(path)
          .filter(([key, data]) => operator === "==" ? data[field] === value : true)
          .map(([key, data]) => ({id: key.slice(path.length + 1), data: () => clone(data)}))})})}),
    };
  }
  function doc(path) {
    return {
      set: async value => values.set(path, clone(value)),
      collection: name => ({limit: () => ({get: async () => ({docs: db.docs(`${path}/${name}`).map(([key, data]) => ({
        id: key.slice(`${path}/${name}/`.length), data: () => clone(data),
      }))})})}),
    };
  }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
