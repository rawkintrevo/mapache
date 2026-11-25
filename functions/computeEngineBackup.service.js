"use strict";

const {createHash} = require("node:crypto");
const {GoogleAuth} = require("google-auth-library");
const {COMPUTE_ENGINE_BACKEND, normalizeRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {
  assertSnapshotDeletionAllowed,
  backupPolicy,
  createBackupRecord,
  createRestoreReceipt,
  diskCapacitySummary,
  markBackupVerified,
  markRestoreVerified,
  planSnapshotRetention,
} = require("./vmBackupPolicy.helpers");

function createComputeEngineBackupService(dependencies = {}) {
  const auth = dependencies.auth || new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]});
  const requestImpl = dependencies.request || (async (options) => (await auth.getClient()).request(options));
  const projectId = String(dependencies.projectId || "pi-agents-cloud").trim();
  const now = dependencies.now || (() => new Date().toISOString());

  return {
    createSnapshot,
    inspectSnapshot,
    listSnapshots,
    restoreSnapshot,
    deleteSnapshot,
    costSummary,
    backupPolicy,
    createBackupRecord,
    createRestoreReceipt,
    diskCapacitySummary,
    markBackupVerified,
    markRestoreVerified,
    planSnapshotRetention,
    assertSnapshotDeletionAllowed,
  };

  async function createSnapshot(rawDescriptor, {
    snapshotName,
    operationId,
    retentionDays,
    consistency = "crash-consistent",
    quiescedAt,
    sourceDiskId,
    sourceGeneration,
  } = {}) {
    const descriptor = normalizeRuntimeDescriptor(rawDescriptor, {workspaceId: rawDescriptor.workspaceId, ownerUid: rawDescriptor.ownerUid});
    const name = safeName(snapshotName || `${descriptor.dataDiskName}-${Date.now()}`);
    const record = createBackupRecord({workspaceId: descriptor.workspaceId, ownerUid: descriptor.ownerUid,
      operationId, sourceDisk: descriptor.dataDiskName, sourceDiskId, sourceGeneration: sourceGeneration || descriptor.generation,
      consistency, quiescedAt, retentionDays, capturedAt: now()});
    const response = await requestImpl({
      url: `${diskUrl(descriptor)}/createSnapshot`,
      method: "POST",
      data: {name, labels: labels(descriptor, operationId, record.retention.retentionDays, {
        consistency: record.consistency,
        sourceGeneration: record.sourceGeneration,
        backupState: record.state,
      }), storageLocations: [descriptor.region]},
    });
    return {...record, name, operation: response.data};
  }

  async function inspectSnapshot(rawDescriptor, snapshotName) {
    const descriptor = normalizeRuntimeDescriptor(rawDescriptor, {workspaceId: rawDescriptor.workspaceId, ownerUid: rawDescriptor.ownerUid});
    const response = await requestImpl({url: `${baseUrl()}/global/snapshots/${encodeURIComponent(safeName(snapshotName))}`, method: "GET"});
    assertOwnership(response.data, descriptor);
    return response.data;
  }

  async function listSnapshots(rawDescriptor, {maxResults = 100} = {}) {
    const descriptor = normalizeRuntimeDescriptor(rawDescriptor, {workspaceId: rawDescriptor.workspaceId, ownerUid: rawDescriptor.ownerUid});
    const limit = Number(maxResults);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      const error = new Error("vm_backup_snapshot_list_limit_invalid");
      error.code = "vm_backup_snapshot_list_limit_invalid";
      throw error;
    }
    const items = [];
    let pageToken;
    do {
      const response = await requestImpl({url: `${baseUrl()}/global/snapshots`, method: "GET",
        params: {maxResults: Math.min(limit - items.length, 500),
          ...(pageToken ? {pageToken} : {})}});
      for (const snapshot of Array.isArray(response.data?.items) ? response.data.items : []) {
        if (items.length >= limit) break;
        items.push(snapshot);
      }
      pageToken = items.length >= limit ? null : response.data?.nextPageToken || null;
    } while (pageToken);
    return items.filter(snapshot => snapshot?.labels?.["mapache-workspace-id"] === descriptor.workspaceId &&
      snapshot?.labels?.["mapache-owner-uid"] === descriptor.ownerUid &&
      snapshot?.labels?.["mapache-runtime-provider"] === COMPUTE_ENGINE_BACKEND);
  }

  async function restoreSnapshot(rawDescriptor, {snapshotName, diskName, sizeGb, operationId} = {}) {
    const descriptor = normalizeRuntimeDescriptor(rawDescriptor, {workspaceId: rawDescriptor.workspaceId, ownerUid: rawDescriptor.ownerUid});
    const snapshot = await inspectSnapshot(descriptor, snapshotName);
    const target = safeName(diskName || `${descriptor.dataDiskName}-restore`);
    if (target === descriptor.dataDiskName) {
      const error = new Error("vm_backup_restore_target_must_be_fresh");
      error.code = "vm_backup_restore_target_must_be_fresh";
      throw error;
    }
    const requestedSizeGb = Number(sizeGb || snapshot.diskSizeGb);
    const sourceSizeGb = Number(snapshot.diskSizeGb);
    if (!Number.isSafeInteger(requestedSizeGb) || requestedSizeGb < 1 ||
        !Number.isSafeInteger(sourceSizeGb) || requestedSizeGb < sourceSizeGb) {
      const error = new Error("vm_backup_restore_size_invalid");
      error.code = "vm_backup_restore_size_invalid";
      throw error;
    }
    const restoreOperationId = String(operationId || "").trim();
    if (!restoreOperationId) {
      const error = new Error("vm_backup_restore_operation_required");
      error.code = "vm_backup_restore_operation_required";
      throw error;
    }
    const sourceGeneration = Number(snapshot.labels?.["mapache-source-generation"] || descriptor.generation);
    const receipt = createRestoreReceipt({workspaceId: descriptor.workspaceId, ownerUid: descriptor.ownerUid,
      operationId: restoreOperationId, sourceSnapshot: snapshot.name, sourceGeneration,
      targetDisk: target, targetZone: descriptor.zone, targetDiskSizeGb: requestedSizeGb, createdAt: now()});
    const response = await requestImpl({
      url: `${zoneUrl(descriptor)}/disks`,
      method: "POST",
      data: {
        name: target,
        sizeGb: requestedSizeGb,
        sourceSnapshot: snapshot.selfLink,
        labels: {...labels(descriptor, restoreOperationId, snapshot.labels?.["mapache-retention-days"] || 14, {
          consistency: snapshot.labels?.["mapache-consistency"] || "crash-consistent",
          sourceGeneration,
          backupState: "restoring",
        }), "mapache-created-generation": String(descriptor.generation),
          "mapache-operation-id": operationLabel(restoreOperationId)},
      },
    });
    const operation = await waitForOperation(response.data, descriptor);
    return {...receipt, diskName: target, operation};
  }

  async function deleteSnapshot(rawDescriptor, snapshotName, options = {}) {
    const descriptor = normalizeRuntimeDescriptor(rawDescriptor, {workspaceId: rawDescriptor.workspaceId, ownerUid: rawDescriptor.ownerUid});
    if (options.providerOperation) {
      const operation = await waitForOperation(options.providerOperation, descriptor);
      return {deleted: operationComplete(operation), pending: !operationComplete(operation), operation};
    }
    const snapshot = await inspectSnapshot(descriptor, snapshotName);
    if (!options.snapshotRecord) {
      const error = new Error("vm_backup_deletion_guard_required");
      error.code = "vm_backup_deletion_guard_required";
      throw error;
    }
    if (options.snapshotRecord.name !== snapshot.name) {
      const error = new Error("vm_backup_snapshot_record_mismatch");
      error.code = "vm_backup_snapshot_record_mismatch";
      throw error;
    }
    assertSnapshotDeletionAllowed({snapshot: options.snapshotRecord, mode: options.mode || "retention",
      ownerUid: descriptor.ownerUid, workspaceId: descriptor.workspaceId, now: options.now,
      computeAbsent: options.computeAbsent, diskDetached: options.diskDetached,
      admissionsBlocked: options.admissionsBlocked});
    const response = await requestImpl({url: `${baseUrl()}/global/snapshots/${encodeURIComponent(snapshot.name)}`, method: "DELETE"});
    const operation = await waitForOperation(response.data, descriptor);
    return {deleted: operationComplete(operation), pending: !operationComplete(operation), operation};
  }

  async function waitForOperation(operation, descriptor, timeoutMs = 240000) {
    if (!operation?.name || operationComplete(operation)) return operation || null;
    const deadline = Date.now() + timeoutMs;
    let current = operation;
    while (!operationComplete(current)) {
      if (Date.now() > deadline) {
        const error = new Error("vm_backup_provider_operation_timeout");
        error.code = "vm_backup_provider_operation_timeout";
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
      const response = await requestImpl({url: operationUrl(current), method: "GET"});
      current = response.data;
    }
    if (current?.error?.errors?.length) {
      const error = new Error("vm_backup_provider_operation_failed");
      error.code = "vm_backup_provider_operation_failed";
      throw error;
    }
    return current;
  }

  function operationComplete(operation) {
    return !operation || String(operation.status || "").toUpperCase() === "DONE" || operation.done === true;
  }

  function operationUrl(operation) {
    const operationName = encodeURIComponent(String(operation.name).split("/").pop());
    const location = String(operation.zone || operation.region || "");
    if (location.includes("/zones/")) return `${baseUrl()}/zones/${encodeURIComponent(location.split("/").pop())}/operations/${operationName}`;
    if (location.includes("/regions/")) return `${baseUrl()}/regions/${encodeURIComponent(location.split("/").pop())}/operations/${operationName}`;
    return `${baseUrl()}/global/operations/${operationName}`;
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
  function labels(descriptor, operationId, retentionDays, extra = {}) {
    return {
      "mapache-owner-uid": descriptor.ownerUid,
      "mapache-workspace-id": descriptor.workspaceId,
      "mapache-runtime-provider": COMPUTE_ENGINE_BACKEND,
      // Compute label values are limited to 63 characters; durable operation
      // IDs are SHA-256 strings, so keep the label deterministic but bounded.
      "mapache-operation-id": operationLabel(operationId || "snapshot"),
      "mapache-retention-days": String(retentionDays || 14),
      ...(extra.consistency ? {"mapache-consistency": String(extra.consistency)} : {}),
      ...(extra.sourceGeneration ? {"mapache-source-generation": String(extra.sourceGeneration)} : {}),
      ...(extra.backupState ? {"mapache-backup-state": String(extra.backupState)} : {}),
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
  function operationLabel(value) { return createHash("sha256").update(String(value)).digest("hex").slice(0, 63); }
  function safeName(value) {
    const name = String(value || "").trim();
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new Error("invalid_snapshot_name");
    return name;
  }
}

module.exports = {createComputeEngineBackupService};
