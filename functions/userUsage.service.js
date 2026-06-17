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

  const [ledgerSnap, sessionDocs] = await Promise.all([
    db.collection("users").doc(uid).collection("sessionUsage").get(),
    listUserSessionDocs(uid),
  ]);

  ledgerSnap.docs.forEach((doc) => {
    const entry = doc.data();
    addUsageTotals(totals, entry);
    addUsageTotals(last30Days, prorateUsageEntry(entry, thirtyDaysAgo, now));
  });

  sessionDocs.forEach((doc) => {
    const session = doc.data();
    if (session.usageAccountedAt) return;
    const entry = sessionUsageEntry(doc.id, session, now);
    if (!entry) return;
    addUsageTotals(totals, entry);
    addUsageTotals(last30Days, prorateUsageEntry(entry, thirtyDaysAgo, now));
  });

  return {
    lifetime: roundUsageTotals(totals),
    last30Days: roundUsageTotals(last30Days),
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
  };
}

function addUsageTotals(target, usage) {
  if (!usage) return;
  target.cpuSeconds += Number(usage.cpuSeconds || 0);
  target.memoryGbSeconds += Number(usage.memoryGbSeconds || 0);
  target.runtimeSeconds += Number(usage.runtimeSeconds || 0);
  target.sessionCount += Number(usage.sessionCount || 0) || (usage.runtimeSeconds > 0 ? 1 : 0);
}

function roundUsageTotals(totals) {
  return {
    cpuSeconds: Math.round(totals.cpuSeconds),
    memoryGbSeconds: Math.round(totals.memoryGbSeconds),
    runtimeSeconds: Math.round(totals.runtimeSeconds),
    sessionCount: Math.round(totals.sessionCount),
  };
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
  const overlapSeconds = Math.max(0, (overlapEnd - overlapStart) / 1000);
  const runtimeSeconds = Number(entry.runtimeSeconds || 0);
  const ratio = runtimeSeconds > 0 ? Math.min(1, overlapSeconds / runtimeSeconds) : 0;

  return {
    runtimeSeconds: overlapSeconds,
    cpuSeconds: Number(entry.cpuSeconds || 0) * ratio,
    memoryGbSeconds: Number(entry.memoryGbSeconds || 0) * ratio,
    sessionCount: overlapSeconds > 0 ? 1 : 0,
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
      recordedAt: endedAt,
    },
  };
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
  return ["stopped", "provision_failed", "needs_image"].includes(cleanName(status));
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
