"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createComputeEngineBackupService} = require("./computeEngineBackup.service");
const {createRuntimeDescriptor, COMPUTE_ENGINE_BACKEND} = require("./runtimeProvider.helpers");

const descriptor = createRuntimeDescriptor({backend: COMPUTE_ENGINE_BACKEND, workspaceId: "workspace-1", ownerUid: "owner-1", zone: "us-central1-a"});

test("backup service labels snapshots and reports known storage cost", async () => {
  const calls = [];
  const service = createComputeEngineBackupService({
    request: async (request) => {
      calls.push(request);
      if (request.method === "GET") return {data: {name: "snapshot-1", diskSizeGb: "64", selfLink: "snapshot-link", labels: {"mapache-owner-uid": "owner-1", "mapache-workspace-id": "workspace-1", "mapache-runtime-provider": "compute-engine"}}};
      return {data: {status: "DONE"}};
    },
  });
  const result = await service.createSnapshot(descriptor, {snapshotName: "snapshot-1", operationId: "op-1"});
  assert.equal(result.name, "snapshot-1");
  assert.equal(calls[0].data.labels["mapache-workspace-id"], "workspace-1");
  assert.deepEqual(service.costSummary({retainedGiB: 64, changedSnapshotGiB: 8}), {
    retainedStorageMonthlyUsd: 6.4,
    snapshotStorageMonthlyUsd: 0.52,
    totalKnownMonthlyUsd: 6.92,
    ratesAreEstimates: true,
  });
});
