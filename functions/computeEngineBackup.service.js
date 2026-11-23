"use strict";

const {GoogleAuth} = require("google-auth-library");
const {COMPUTE_ENGINE_BACKEND, normalizeRuntimeDescriptor} = require("./runtimeProvider.helpers");

function createComputeEngineBackupService(dependencies = {}) {
  const auth = dependencies.auth || new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]});
  const requestImpl = dependencies.request || (async (options) => (await auth.getClient()).request(options));
  const projectId = String(dependencies.projectId || "pi-agents-cloud").trim();
  const now = dependencies.now || (() => new Date().toISOString());

  return {createSnapshot, inspectSnapshot, restoreSnapshot, deleteSnapshot, costSummary};

  async function createSnapshot(rawDescriptor, {snapshotName, operationId, retentionDays = 14} = {}) {
    const descriptor = normalizeRuntimeDescriptor(rawDescriptor, {workspaceId: rawDescriptor.workspaceId, ownerUid: rawDescriptor.ownerUid});
    const name = safeName(snapshotName || `${descriptor.dataDiskName}-${Date.now()}`);
    const response = await requestImpl({
      url: `${diskUrl(descriptor)}/createSnapshot`,
      method: "POST",
      data: {name, labels: labels(descriptor, operationId, retentionDays), storageLocations: [descriptor.region]},
    });
    return {name, operation: response.data, sourceDisk: descriptor.dataDiskName, createdAt: now(), retentionDays};
  }

  async function inspectSnapshot(rawDescriptor, snapshotName) {
    const descriptor = normalizeRuntimeDescriptor(rawDescriptor, {workspaceId: rawDescriptor.workspaceId, ownerUid: rawDescriptor.ownerUid});
    const response = await requestImpl({url: `${baseUrl()}/global/snapshots/${encodeURIComponent(safeName(snapshotName))}`, method: "GET"});
    assertOwnership(response.data, descriptor);
    return response.data;
  }

  async function restoreSnapshot(rawDescriptor, {snapshotName, diskName, sizeGb} = {}) {
    const descriptor = normalizeRuntimeDescriptor(rawDescriptor, {workspaceId: rawDescriptor.workspaceId, ownerUid: rawDescriptor.ownerUid});
    const snapshot = await inspectSnapshot(descriptor, snapshotName);
    const target = safeName(diskName || `${descriptor.dataDiskName}-restore`);
    const response = await requestImpl({
      url: `${zoneUrl(descriptor)}/disks`,
      method: "POST",
      data: {
        name: target,
        sizeGb: Number(sizeGb || snapshot.diskSizeGb),
        sourceSnapshot: snapshot.selfLink,
        labels: labels(descriptor, `restore-${Date.now()}`),
      },
    });
    return {diskName: target, operation: response.data, sourceSnapshot: snapshot.name};
  }

  async function deleteSnapshot(rawDescriptor, snapshotName) {
    const descriptor = normalizeRuntimeDescriptor(rawDescriptor, {workspaceId: rawDescriptor.workspaceId, ownerUid: rawDescriptor.ownerUid});
    const snapshot = await inspectSnapshot(descriptor, snapshotName);
    const response = await requestImpl({url: `${baseUrl()}/global/snapshots/${encodeURIComponent(snapshot.name)}`, method: "DELETE"});
    return {deleted: true, operation: response.data};
  }

  function costSummary({retainedGiB = 0, changedSnapshotGiB = 0, diskRate = 0.10, snapshotRate = 0.065} = {}) {
    return {
      retainedStorageMonthlyUsd: Number(retainedGiB) * Number(diskRate),
      snapshotStorageMonthlyUsd: Number(changedSnapshotGiB) * Number(snapshotRate),
      totalKnownMonthlyUsd: Number(retainedGiB) * Number(diskRate) + Number(changedSnapshotGiB) * Number(snapshotRate),
      ratesAreEstimates: true,
    };
  }

  function baseUrl() { return `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(projectId)}`; }
  function zoneUrl(descriptor) { return `${baseUrl()}/zones/${encodeURIComponent(descriptor.zone)}`; }
  function diskUrl(descriptor) { return `${zoneUrl(descriptor)}/disks/${encodeURIComponent(descriptor.dataDiskName)}`; }
  function labels(descriptor, operationId, retentionDays) {
    return {
      "mapache-owner-uid": descriptor.ownerUid,
      "mapache-workspace-id": descriptor.workspaceId,
      "mapache-runtime-provider": COMPUTE_ENGINE_BACKEND,
      "mapache-operation-id": String(operationId || "snapshot"),
      "mapache-retention-days": String(retentionDays || 14),
    };
  }
  function assertOwnership(resource, descriptor) {
    const actual = resource?.labels || {};
    if (actual["mapache-owner-uid"] !== descriptor.ownerUid || actual["mapache-workspace-id"] !== descriptor.workspaceId || actual["mapache-runtime-provider"] !== COMPUTE_ENGINE_BACKEND) {
      const error = new Error("runtime_resource_ownership_mismatch");
      error.code = "runtime_resource_ownership_mismatch";
      throw error;
    }
  }
  function safeName(value) {
    const name = String(value || "").trim();
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new Error("invalid_snapshot_name");
    return name;
  }
}

module.exports = {createComputeEngineBackupService};
