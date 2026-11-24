"use strict";

const {normalizeRuntimeDescriptor, COMPUTE_ENGINE_BACKEND} = require("./runtimeProvider.helpers");
const {backupPolicy, planSnapshotRetention} = require("./vmBackupPolicy.helpers");

const REPORTS = "vmBackupInventoryReports_v2";
const MAX_SCAN = 100;

function createVmBackupInventoryService({db, provider, now = Date.now, logger = console} = {}) {
  if (!db || !provider || typeof provider.inspect !== "function" || typeof provider.listSnapshots !== "function") {
    throw new Error("vm_backup_inventory_dependencies_required");
  }
  return {inspectWorkspace, runTick};

  async function runTick() {
    const runtimes = await db.collection("vmRuntimes_v2").where("backend", "==", COMPUTE_ENGINE_BACKEND).limit(MAX_SCAN).get();
    const result = {checked: runtimes.docs.length, reported: 0, skipped: 0, failed: 0};
    for (const doc of runtimes.docs) {
      const runtime = doc.data() || {};
      if (runtime.backupPolicy?.enabled !== true) {
        result.skipped++;
        continue;
      }
      try {
        await inspectWorkspace({workspaceId: doc.id, runtime});
        result.reported++;
      } catch (error) {
        result.failed++;
        logger.warn?.("VM backup inventory failed", {workspaceId: doc.id, errorCode: safeErrorCode(error)});
      }
    }
    return result;
  }

  async function inspectWorkspace({workspaceId, runtime} = {}) {
    if (!runtime || runtime.ownerUid === undefined || runtime.backend !== COMPUTE_ENGINE_BACKEND ||
        runtime.backupPolicy?.enabled !== true) throw inventoryError("vm_backup_inventory_runtime_not_admitted");
    const descriptor = normalizeRuntimeDescriptor(runtime.runtimeProvider || runtime.runtimeProviderDescriptor,
        {workspaceId, ownerUid: runtime.ownerUid});
    const [compute, providerResources, providerSnapshots, backupItems] = await Promise.all([
      provider.inspect(descriptor),
      typeof provider.listOwnedResources === "function" ? provider.listOwnedResources(descriptor) : null,
      provider.listSnapshots(descriptor),
      db.collection("vmBackups_v2").doc(workspaceId).collection("items").limit(MAX_SCAN).get(),
    ]);
    const snapshots = backupItems.docs.map(doc => ({id: doc.id, ...doc.data()}));
    const report = buildInventoryReport({workspaceId, ownerUid: runtime.ownerUid, runtime, compute, snapshots,
      providerResources, providerSnapshots, observedAtMs: now()});
    await db.collection(REPORTS).doc(workspaceId).set(report);
    return report;
  }
}

function buildInventoryReport({workspaceId, ownerUid, runtime = {}, compute = {}, providerResources = null,
  snapshots = [], providerSnapshots = snapshots,
  observedAtMs = Date.now()} = {}) {
  const observedAt = new Date(observedAtMs);
  if (Number.isNaN(observedAt.getTime())) throw inventoryError("vm_backup_inventory_time_invalid");
  const policy = normalizedPolicy(runtime.backupPolicy);
  const retention = planSnapshotRetention({snapshots, ownerUid, workspaceId, now: observedAt});
  const disk = compute.disk || null;
  const instance = compute.instance || null;
  const instanceRunning = instance?.status === "RUNNING";
  const diskSizeGb = finitePositive(disk?.sizeGb);
  const snapshotGiB = providerSnapshots.reduce((total, snapshot) => total + (finitePositive(snapshot?.storageBytes) ||
    (finitePositive(snapshot?.diskSizeGb) || 0) * 1024 ** 3), 0) / 1024 ** 3;
  const lastVerified = snapshots
      .filter(snapshot => snapshot?.verification?.state === "verified" || snapshot?.state === "verified")
      .map(snapshot => Date.parse(snapshot.verification?.verifiedAt || snapshot.verifiedAt || snapshot.capturedAt || ""))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0] || null;
  const backupAgeMs = lastVerified === null ? null : Math.max(0, observedAt.getTime() - lastVerified);
  const cost = estimatedCost({diskGiB: diskSizeGb, snapshotGiB, instanceRunning,
    activeHours: instanceRunning ? 24 * 30 : 0});
  const resourceInventory = summarizeProviderResources(providerResources);
  const expectedInstanceName = runtime.runtimeProvider?.instanceName || runtime.runtimeProviderDescriptor?.instanceName || instance?.name || null;
  const expectedDiskName = runtime.runtimeProvider?.dataDiskName || runtime.runtimeProviderDescriptor?.dataDiskName || disk?.name || null;
  return {
    version: 2,
    kind: "compute-engine-backup-inventory",
    workspaceId,
    ownerUid,
    observedAt: observedAt.toISOString(),
    policy: {schedule: policy.schedule, retentionDays: policy.retentionDays,
      rpoTargetMs: policy.rpoTargetMs, rtoTargetMs: policy.rtoTargetMs},
    compute: {
      instancePresent: Boolean(instance),
      instanceStatus: instance?.status || null,
      instanceRunning,
      diskPresent: Boolean(disk),
      diskStatus: disk?.status || null,
      diskAttached: Array.isArray(disk?.users) ? disk.users.length > 0 : null,
      diskSizeGb,
      headroomKnown: false,
    },
    providerResources: resourceInventory,
    backups: {
      observed: snapshots.length,
      providerObserved: providerSnapshots.length,
      verified: snapshots.filter(snapshot => snapshot?.verification?.state === "verified" || snapshot?.state === "verified").length,
      backupAgeMs,
      oldestPending: snapshots.some(snapshot => ["creating", "restoring", "verification-pending"].includes(snapshot?.state)),
      retentionCandidates: retention.delete,
      held: retention.hold,
      quarantined: retention.quarantine,
    },
    strandedResources: {
      diskDetached: Array.isArray(disk?.users) ? disk.users.length === 0 : null,
      instanceWithoutDisk: Boolean(instance) && !disk,
      diskWithoutInstance: Boolean(disk) && !instance,
      ownedInstanceCount: resourceInventory.known ? resourceInventory.instances.length : null,
      ownedDiskCount: resourceInventory.known ? resourceInventory.disks.length : null,
      unexpectedOwnedInstances: resourceInventory.known ? resourceInventory.instances.filter(item => item.name !== expectedInstanceName).map(item => item.name) : [],
      unexpectedOwnedDisks: resourceInventory.known ? resourceInventory.disks.filter(item => item.name !== expectedDiskName).map(item => item.name) : [],
      resourceInventoryKnown: resourceInventory.known,
      cleanupAllowed: false,
      reason: "inventory_is_read_only",
    },
    cost,
  };
}

function summarizeProviderResources(resources) {
  if (!resources || !Array.isArray(resources.instances) || !Array.isArray(resources.disks)) {
    return {known: false, instances: [], disks: []};
  }
  return {
    known: true,
    instances: resources.instances.slice(0, MAX_SCAN).map(resource => ({name: resource.name || null, status: resource.status || null})),
    disks: resources.disks.slice(0, MAX_SCAN).map(resource => ({name: resource.name || null, status: resource.status || null,
      sizeGb: finitePositive(resource.sizeGb), users: Array.isArray(resource.users) ? resource.users.length : null})),
  };
}

function estimatedCost({diskGiB = 0, snapshotGiB = 0, instanceRunning = false, activeHours = 0,
  diskRate = 0.10, snapshotRate = 0.065, computeHourlyRate = null} = {}) {
  const retainedStorageMonthlyUsd = finiteNonNegative(diskGiB) * finiteNonNegative(diskRate);
  const snapshotStorageMonthlyUsd = finiteNonNegative(snapshotGiB) * finiteNonNegative(snapshotRate);
  const computeMonthlyUsd = computeHourlyRate === null ? null : finiteNonNegative(activeHours) * finiteNonNegative(computeHourlyRate);
  const known = retainedStorageMonthlyUsd + snapshotStorageMonthlyUsd + (computeMonthlyUsd || 0);
  return {
    retainedStorageMonthlyUsd,
    snapshotStorageMonthlyUsd,
    computeMonthlyUsd,
    totalKnownMonthlyUsd: known,
    ratesAreEstimates: true,
    unknownComponents: ["network", "gateway", "nat", ...(computeHourlyRate === null ? ["compute"] : [])],
    assumptions: {diskRate, snapshotRate, computeHourlyRate, activeHours, instanceRunning},
  };
}

function normalizedPolicy(value = {}) {
  const defaults = backupPolicy();
  return {
    schedule: value.schedule || defaults.schedule,
    retentionDays: Number.isSafeInteger(Number(value.retentionDays)) ? Number(value.retentionDays) : defaults.retentionDays,
    rpoTargetMs: Number.isSafeInteger(Number(value.rpoTargetMs)) ? Number(value.rpoTargetMs) : defaults.rpoTargetMs,
    rtoTargetMs: Number.isSafeInteger(Number(value.rtoTargetMs)) ? Number(value.rtoTargetMs) : defaults.rtoTargetMs,
  };
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function safeErrorCode(error) {
  return String(error?.publicMessage || error?.code || error?.message || "vm_backup_inventory_failed").slice(0, 120);
}

function inventoryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {MAX_SCAN, REPORTS, buildInventoryReport, createVmBackupInventoryService, estimatedCost};
