"use strict";

const logger = require("firebase-functions/logger");
const {
  admin,
  db,
} = require("./backendContext");
const {
  DEFAULT_CPU,
  DEFAULT_MEMORY,
} = require("./backendConfig");
const {
  cleanName,
  timestampMillis,
} = require("./backendUtils.helpers");
const {isSessionTerminal} = require("./sessionLifecycle.helpers");
const {isAutomationRuntime} = require("./runtimePaths.helpers");
const {vmBackgroundUsageEntry, vmUsageEntry, VM_RUNTIME_KIND} = require("./vmUsage.service");

async function userWithUsage(user) {
  return {
    ...user,
    usage: await getUserSessionUsage(user.uid),
  };
}

async function getUserSessionUsage(uid) {
  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
  const totals = createUsageTotals();
  const last30Days = createUsageTotals();
  const byRuntimeKind = {
    main: createUsageTotals(),
    automation: createUsageTotals(),
    vm: createUsageTotals(),
  };
  const last30DaysByRuntimeKind = {
    main: createUsageTotals(),
    automation: createUsageTotals(),
    vm: createUsageTotals(),
  };

  const [ledgerSnap, sessionDocs, vmRuntimeDocs, automationRunDocs] = await Promise.all([
    db.collection("users").doc(uid).collection("sessionUsage").get(),
    listUserSessionDocs(uid),
    listUserVmRuntimeDocs(uid),
    listUserAutomationRunDocs(uid),
  ]);

  ledgerSnap.docs.forEach((doc) => {
    const entry = doc.data();
    addUsageTotals(totals, entry);
    addUsageTotals(byRuntimeKind[runtimeKindForEntry(entry)], entry);
    const recent = prorateUsageEntry(entry, thirtyDaysAgo, now);
    addUsageTotals(last30Days, recent);
    addUsageTotals(last30DaysByRuntimeKind[runtimeKindForEntry(entry)], recent);
  });

  sessionDocs.forEach((doc) => {
    const session = doc.data();
    if (session.usageAccountedAt) return;
    const entry = sessionUsageEntry(doc.id, session, now);
    if (!entry) return;
    addUsageTotals(totals, entry);
    addUsageTotals(byRuntimeKind[runtimeKindForEntry(session)], entry);
    const recent = prorateUsageEntry(entry, thirtyDaysAgo, now);
    addUsageTotals(last30Days, recent);
    addUsageTotals(last30DaysByRuntimeKind[runtimeKindForEntry(session)], recent);
  });

  const vmSessions = await readCurrentVmSessions(vmRuntimeDocs);
  vmSessions.forEach(({workspaceId, runtime, session}) => {
    if (session.usageAccountedAt || runtime.state !== "active") return;
    const entry = vmUsageEntry({workspaceId, ownerUid: uid, generation: runtime.generation,
      operationId: `live-${workspaceId}-${runtime.generation}`, workspace: runtime, session,
      endedAtMs: now, includeActiveRuntime: true});
    addUsageEntry(totals, last30Days, byRuntimeKind, last30DaysByRuntimeKind, entry, thirtyDaysAgo, now);
  });

  automationRunDocs.forEach((doc) => {
    const entry = vmBackgroundUsageEntry(doc.data() || {}, now);
    addUsageEntry(totals, last30Days, byRuntimeKind, last30DaysByRuntimeKind, entry, thirtyDaysAgo, now);
  });

  return {
    lifetime: roundUsageTotals(totals),
    last30Days: roundUsageTotals(last30Days),
    byRuntimeKind: {
      lifetime: roundUsageTotalsByRuntimeKind(byRuntimeKind),
      last30Days: roundUsageTotalsByRuntimeKind(last30DaysByRuntimeKind),
    },
  };
}

async function listUserSessionDocs(uid) {
  try {
    const snap = await db.collectionGroup("sessions")
        .where("ownerUid", "==", uid)
        .get();
    return snap.docs;
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;
    logger.warn("sessions collection group index not ready; falling back to workspace session scan", {
      uid,
      error: error.message,
    });
    return listUserSessionDocsByWorkspace(uid);
  }
}

async function listUserSessionDocsByWorkspace(uid) {
  const workspaceSnap = await db.collection("workspaces")
      .where("ownerUid", "==", uid)
      .get();
  const sessionSnaps = await Promise.all(
      workspaceSnap.docs.map((doc) => doc.ref.collection("sessions").get()),
  );
  return sessionSnaps.flatMap((snap) => snap.docs);
}

async function listUserVmRuntimeDocs(uid) {
  const snap = await db.collection("vmRuntimes_v2").where("ownerUid", "==", uid).get();
  return snap.docs.filter((doc) => doc.data()?.backend === "compute-engine");
}

async function listUserAutomationRunDocs(uid) {
  try {
    const snap = await db.collection("automationRuns").where("ownerUid", "==", uid).get();
    return snap.docs;
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;
    const snap = await db.collection("automationRuns").get();
    return snap.docs.filter((doc) => doc.data()?.ownerUid === uid);
  }
}

async function readCurrentVmSessions(runtimeDocs) {
  return (await Promise.all(runtimeDocs.map(async (doc) => {
    const runtime = doc.data() || {};
    const sessionId = cleanName(runtime.currentSessionId || "");
    if (!sessionId || !doc.ref?.collection) return null;
    const sessionSnap = await doc.ref.collection("sessions").doc(sessionId).get();
    if (!sessionSnap.exists) return null;
    return {workspaceId: doc.id, runtime, session: sessionSnap.data() || {}};
  }))).filter(Boolean);
}

function isMissingIndexError(error) {
  const message = cleanName(error && error.message).toLowerCase();
  return error && (error.code === 9 || error.code === "failed-precondition") &&
    message.includes("index");
}

function createUsageTotals() {
  return {
    cpuSeconds: 0,
    memoryGbSeconds: 0,
    runtimeSeconds: 0,
    sessionCount: 0,
    vmRuntimeSeconds: 0,
    retainedStorageGbSeconds: 0,
    retainedStorageUnknownIntervals: 0,
    backgroundRuntimeSeconds: 0,
    backgroundRunCount: 0,
  };
}

function addUsageTotals(target, usage) {
  if (!usage) return;
  target.cpuSeconds += Number(usage.cpuSeconds || 0);
  target.memoryGbSeconds += Number(usage.memoryGbSeconds || 0);
  target.runtimeSeconds += Number(usage.runtimeSeconds || 0);
  target.sessionCount += Number(usage.sessionCount || 0) || (usage.runtimeSeconds > 0 ? 1 : 0);
  target.vmRuntimeSeconds += Number(usage.vmRuntimeSeconds || 0);
  target.retainedStorageGbSeconds += Number(usage.retainedStorageGbSeconds || 0);
  if (usage.retainedStorageKnown === false) target.retainedStorageUnknownIntervals += 1;
  target.backgroundRuntimeSeconds += Number(usage.backgroundRuntimeSeconds || 0);
  target.backgroundRunCount += Number(usage.backgroundRunCount || 0);
}

function roundUsageTotals(totals) {
  return {
    cpuSeconds: Math.round(totals.cpuSeconds),
    memoryGbSeconds: Math.round(totals.memoryGbSeconds),
    runtimeSeconds: Math.round(totals.runtimeSeconds),
    sessionCount: Math.round(totals.sessionCount),
    vmRuntimeSeconds: Math.round(totals.vmRuntimeSeconds),
    retainedStorageGbSeconds: Math.round(totals.retainedStorageGbSeconds),
    retainedStorageUnknownIntervals: Math.round(totals.retainedStorageUnknownIntervals),
    backgroundRuntimeSeconds: Math.round(totals.backgroundRuntimeSeconds),
    backgroundRunCount: Math.round(totals.backgroundRunCount),
  };
}

function roundUsageTotalsByRuntimeKind(totals = {}) {
  return {
    main: roundUsageTotals(totals.main || createUsageTotals()),
    automation: roundUsageTotals(totals.automation || createUsageTotals()),
    vm: roundUsageTotals(totals.vm || createUsageTotals()),
  };
}

function addUsageEntry(totals, last30Days, byRuntimeKind, last30DaysByRuntimeKind, entry,
  windowStartMs, windowEndMs) {
  if (!entry) return;
  addUsageTotals(totals, entry);
  addUsageTotals(byRuntimeKind[runtimeKindForEntry(entry)] || byRuntimeKind.main, entry);
  const recent = prorateUsageEntry(entry, windowStartMs, windowEndMs);
  addUsageTotals(last30Days, recent);
  addUsageTotals(last30DaysByRuntimeKind[runtimeKindForEntry(entry)] || last30DaysByRuntimeKind.main, recent);
}

function sessionUsageEntry(sessionId, session, fallbackEndMs = Date.now()) {
  const startedMs = timestampMillis(session.createdAt);
  if (!startedMs) return null;

  const endedMs = timestampMillis(session.stoppedAt) ||
    (isTerminalSessionStatus(session.status) ? timestampMillis(session.updatedAt) : 0) ||
    fallbackEndMs;
  if (!endedMs || endedMs <= startedMs) return null;

  const intervalStartMs = Math.max(startedMs, timestampMillis(session.usageAccruedAt) || startedMs);
  const intervalSeconds = Math.max(0, (endedMs - intervalStartMs) / 1000);
  const cpu = parseCpuCount(session.resources && session.resources.cpu);
  const memoryGb = parseMemoryGb(session.resources && session.resources.memory);
  const accruedCpuSeconds = Number(session.usageAccruedCpuSeconds || 0);
  const accruedMemoryGbSeconds = Number(session.usageAccruedMemoryGbSeconds || 0);
  const accruedRuntimeSeconds = Number(session.usageAccruedRuntimeSeconds || 0);

  return {
    sessionId,
    workspaceId: cleanName(session.workspaceId || ""),
    startedAt: admin.firestore.Timestamp.fromMillis(startedMs),
    endedAt: admin.firestore.Timestamp.fromMillis(endedMs),
    cpu,
    memoryGb,
    runtimeSeconds: accruedRuntimeSeconds + intervalSeconds,
    cpuSeconds: accruedCpuSeconds + (intervalSeconds * cpu),
    memoryGbSeconds: accruedMemoryGbSeconds + (intervalSeconds * memoryGb),
    sessionCount: 1,
    runtimeKind: runtimeKindForEntry(session),
  };
}

function accrueSessionUsage(session, accruedAt) {
  const current = sessionUsageEntry(
      cleanName(session.runnerSessionId || ""),
      session,
      accruedAt.toMillis(),
  );

  return {
    usageAccruedAt: accruedAt,
    usageAccruedCpuSeconds: current ? current.cpuSeconds : Number(session.usageAccruedCpuSeconds || 0),
    usageAccruedMemoryGbSeconds: current ?
      current.memoryGbSeconds :
      Number(session.usageAccruedMemoryGbSeconds || 0),
    usageAccruedRuntimeSeconds: current ?
      current.runtimeSeconds :
      Number(session.usageAccruedRuntimeSeconds || 0),
  };
}

function prorateUsageEntry(entry, windowStartMs, windowEndMs) {
  const startedMs = timestampMillis(entry.startedAt);
  const endedMs = timestampMillis(entry.endedAt);
  if (!startedMs || !endedMs || endedMs <= windowStartMs || startedMs >= windowEndMs) {
    return null;
  }

  const overlapStart = Math.max(startedMs, windowStartMs);
  const overlapEnd = Math.min(endedMs, windowEndMs);
  const storageOverlapSeconds = Math.max(0, (overlapEnd - overlapStart) / 1000);
  const hasSeparateAccounting = Object.hasOwn(entry, "runtimeStartedAt") ||
    Object.hasOwn(entry, "runtimeEndedAt") || Object.hasOwn(entry, "retainedStorageGbSeconds") ||
    Object.hasOwn(entry, "backgroundRuntimeSeconds");
  if (!hasSeparateAccounting) {
    const runtimeSeconds = Number(entry.runtimeSeconds || 0);
    const ratio = runtimeSeconds > 0 ? Math.min(1, storageOverlapSeconds / runtimeSeconds) : 0;
    return {
      runtimeSeconds: storageOverlapSeconds,
      cpuSeconds: Number(entry.cpuSeconds || 0) * ratio,
      memoryGbSeconds: Number(entry.memoryGbSeconds || 0) * ratio,
      sessionCount: storageOverlapSeconds > 0 ? 1 : 0,
    };
  }
  const hasExplicitRuntimeWindow = Boolean(entry.runtimeStartedAt || entry.runtimeEndedAt);
  const runtimeStartedMs = timestampMillis(entry.runtimeStartedAt) || startedMs;
  const runtimeEndedMs = timestampMillis(entry.runtimeEndedAt) || endedMs;
  const runtimeOverlapStart = Math.max(runtimeStartedMs, windowStartMs);
  const runtimeOverlapEnd = Math.min(runtimeEndedMs, windowEndMs);
  const runtimeOverlapSeconds = entry.vmRuntimeSeconds !== undefined && !hasExplicitRuntimeWindow ? 0 :
    Math.max(0, (runtimeOverlapEnd - runtimeOverlapStart) / 1000);
  const runtimeWindowSeconds = entry.vmRuntimeSeconds !== undefined && !hasExplicitRuntimeWindow ? 0 :
    Math.max(0, (runtimeEndedMs - runtimeStartedMs) / 1000);
  const runtimeRatio = runtimeWindowSeconds > 0 ? Math.min(1, runtimeOverlapSeconds / runtimeWindowSeconds) : 0;
  const storageWindowSeconds = Math.max(0, (endedMs - startedMs) / 1000);
  const storageRatio = storageWindowSeconds > 0 ? Math.min(1, storageOverlapSeconds / storageWindowSeconds) : 0;
  const runtimeSeconds = Number(entry.runtimeSeconds || 0);

  return {
    runtimeSeconds: entry.backgroundRuntimeSeconds !== undefined ? 0 :
      (entry.vmRuntimeSeconds !== undefined ? runtimeSeconds * runtimeRatio : storageOverlapSeconds),
    cpuSeconds: Number(entry.cpuSeconds || 0) * runtimeRatio,
    memoryGbSeconds: Number(entry.memoryGbSeconds || 0) * runtimeRatio,
    sessionCount: runtimeOverlapSeconds > 0 && !entry.backgroundRuntimeSeconds ? 1 : 0,
    vmRuntimeSeconds: Number(entry.vmRuntimeSeconds || 0) * runtimeRatio,
    retainedStorageGbSeconds: Number(entry.retainedStorageGbSeconds || 0) * storageRatio,
    retainedStorageKnown: entry.retainedStorageKnown,
    backgroundRuntimeSeconds: Number(entry.backgroundRuntimeSeconds || 0) * storageRatio,
    backgroundRunCount: storageOverlapSeconds > 0 ? Number(entry.backgroundRunCount || 0) : 0,
  };
}

function sessionUsageRecord(sessionRef, session, endedAt) {
  if (!session || session.usageAccountedAt || !session.ownerUid) return null;
  const entry = sessionUsageEntry(sessionRef.id, session, endedAt.toMillis());
  if (!entry) return null;

  const userUsageRef = db.collection("users")
      .doc(session.ownerUid)
      .collection("sessionUsage")
      .doc(sessionRef.id);

  return {
    ref: userUsageRef,
    data: {
      ...entry,
      ownerUid: session.ownerUid,
      runtimeKind: runtimeKindForEntry(session),
      recordedAt: endedAt,
    },
  };
}

function runtimeKindForEntry(value = {}) {
  if (value.runtimeKind === VM_RUNTIME_KIND) return VM_RUNTIME_KIND;
  if (value.runtimeKind === "automation") return "automation";
  return isAutomationRuntime(value) ? "automation" : "main";
}

function parseCpuCount(value) {
  const number = Number.parseFloat(cleanName(value || DEFAULT_CPU));
  return Number.isFinite(number) && number > 0 ? number : Number.parseFloat(DEFAULT_CPU) || 1;
}

function parseMemoryGb(value) {
  const raw = cleanName(value || DEFAULT_MEMORY).toLowerCase();
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)(ki|mi|gi|ti|k|m|g|t)?$/);
  if (!match) return parseMemoryGb(DEFAULT_MEMORY) || 1;
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number) || number <= 0) return parseMemoryGb(DEFAULT_MEMORY) || 1;
  const unit = match[2] || "g";
  if (unit === "ki" || unit === "k") return number / (1024 * 1024);
  if (unit === "mi" || unit === "m") return number / 1024;
  if (unit === "ti" || unit === "t") return number * 1024;
  return number;
}

function isTerminalSessionStatus(status) {
  return isSessionTerminal(status) || ["provision_failed"].includes(cleanName(status));
}

module.exports = {
  accrueSessionUsage,
  getUserSessionUsage,
  isTerminalSessionStatus,
  parseCpuCount,
  parseMemoryGb,
  prorateUsageEntry,
  sessionUsageEntry,
  sessionUsageRecord,
  userWithUsage,
};
