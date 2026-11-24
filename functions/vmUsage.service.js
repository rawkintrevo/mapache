"use strict";

const {timestampMillis} = require("./backendUtils.helpers");

const VM_USAGE_LEDGER_PREFIX = "vm-";
const VM_RUNTIME_KIND = "vm";

/**
 * Build one immutable usage interval for a VM lifecycle operation. The
 * operation ID, rather than the generation, is the idempotency key because a
 * start from a stopped machine accrues retained storage without starting a
 * second active runtime interval for the old generation.
 */
function vmUsageEntry({workspaceId, ownerUid, generation, operationId, workspace = {}, session = {},
  endedAtMs, includeActiveRuntime = true} = {}) {
  const end = finiteTime(endedAtMs);
  const storageStart = firstTime(
      workspace.retainedStorageAccruedAtMs,
      workspace.createdAtMs,
      workspace.createdAt,
      session.createdAtMs,
      session.createdAt,
  );
  if (!workspaceId || !ownerUid || !Number.isSafeInteger(Number(generation)) || Number(generation) < 1 ||
      !operationId || !end || !storageStart || end <= storageStart) return null;

  const runtimeStart = includeActiveRuntime ? firstTime(
      session.runtimeStartedAt,
      session.startedAt,
  ) : 0;
  const diskSizeGb = retainedDiskSizeGb(workspace);
  const storageSeconds = (end - storageStart) / 1000;
  const runtimeSeconds = runtimeStart && end > runtimeStart ? (end - runtimeStart) / 1000 : 0;

  return {
    workspaceId,
    ownerUid,
    generation: Number(generation),
    operationId,
    runtimeKind: VM_RUNTIME_KIND,
    runtimeProvider: "compute-engine",
    startedAt: storageStart,
    endedAt: end,
    runtimeStartedAt: runtimeStart || null,
    runtimeEndedAt: runtimeStart ? end : null,
    retainedStorageStartedAt: storageStart,
    retainedStorageEndedAt: end,
    runtimeSeconds,
    vmRuntimeSeconds: runtimeSeconds,
    retainedStorageGbSeconds: diskSizeGb === null ? 0 : storageSeconds * diskSizeGb,
    retainedDiskSizeGb: diskSizeGb,
    retainedStorageKnown: diskSizeGb !== null,
    cpuSeconds: 0,
    memoryGbSeconds: 0,
    sessionCount: runtimeSeconds > 0 ? 1 : 0,
    recordedAt: end,
  };
}

/**
 * Record the old VM interval inside the lifecycle transaction. A worker can
 * safely retry after an uncertain response because the deterministic ledger
 * document and retained-storage cursor are committed together.
 */
async function recordVmUsageInTransaction({db, tx, workspaceRef, sessionRef, workspaceId, workspace,
  session, ownerUid, generation, operationId, endedAtMs, includeActiveRuntime = true} = {}) {
  const ledgerId = vmUsageLedgerId(workspaceId, operationId);
  const ledgerRef = db.collection("users").doc(ownerUid).collection("sessionUsage").doc(ledgerId);
  const existing = await tx.get(ledgerRef);
  if (existing.exists) return {recorded: false, reason: "already_recorded", ledgerId};

  const entry = vmUsageEntry({workspaceId, ownerUid, generation, operationId, workspace, session,
    endedAtMs, includeActiveRuntime});
  if (!entry) return {recorded: false, reason: "usage_interval_unavailable", ledgerId};

  tx.set(ledgerRef, entry);
  tx.update(workspaceRef, {retainedStorageAccruedAtMs: entry.endedAt});
  if (sessionRef) tx.update(sessionRef, {usageAccountedAt: entry.endedAt});
  return {recorded: true, ledgerId, entry};
}

function vmUsageLedgerId(workspaceId, operationId) {
  const workspace = String(workspaceId || "").trim();
  const operation = String(operationId || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspace) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operation)) {
    throw new Error("invalid_vm_usage_identity");
  }
  return `${VM_USAGE_LEDGER_PREFIX}${workspace}-${operation}`;
}

function retainedDiskSizeGb(workspace = {}) {
  const candidates = [
    workspace.retainedDiskSizeGb,
    workspace.machineConfig?.applied?.diskSizeGb,
    workspace.machineConfig?.desired?.diskSizeGb,
  ];
  for (const value of candidates) {
    const size = Number(value);
    if (Number.isSafeInteger(size) && size >= 10 && size <= 4096) return size;
  }
  return null;
}

function vmBackgroundUsageEntry(run = {}, nowMs = Date.now()) {
  if (run.executionRoute !== "vm-native-v1") return null;
  const startedAt = firstTime(run.executionStartedAt, run.startedAt);
  if (!startedAt) return null;
  const terminal = new Set(["succeeded", "failed", "canceled", "cancelled", "interrupted"])
      .has(String(run.status || "").trim().toLowerCase());
  const endedAt = firstTime(run.completedAt, run.finishedAt, terminal ? run.updatedAt : 0) || finiteTime(nowMs);
  if (!endedAt || endedAt <= startedAt) return null;
  const seconds = (endedAt - startedAt) / 1000;
  return {
    runtimeKind: "automation",
    startedAt,
    endedAt,
    runtimeSeconds: 0,
    backgroundRuntimeSeconds: seconds,
    backgroundRunCount: 1,
    sessionCount: 0,
  };
}

function firstTime(...values) {
  for (const value of values) {
    const time = timestampMillis(value);
    if (time > 0) return time;
  }
  return 0;
}

function finiteTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time : 0;
}

module.exports = {
  VM_RUNTIME_KIND,
  VM_USAGE_LEDGER_PREFIX,
  retainedDiskSizeGb,
  recordVmUsageInTransaction,
  vmBackgroundUsageEntry,
  vmUsageEntry,
  vmUsageLedgerId,
};
