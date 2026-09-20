"use strict";

const {db: defaultDb} = require("./backendContext");
const {httpError, serialize} = require("./backendUtils.helpers");
const {isAutomationRuntime} = require("./runtimePaths.helpers");

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const ACTIVE_SESSION_STATUSES = Object.freeze(["provisioning", "running", "stopping", "stop_failed", "delete_failed"]);
const ACTIVE_RUN_STATUSES = Object.freeze(["provisioning", "running", "stopping"]);
const INSTANCE_STATUSES = Object.freeze(["provisioning", "running", "stopping", "cleanup-error"]);

function createActiveInstancesService(dependencies = {}) {
  const shared = {db: dependencies.db || defaultDb};
  return {
    listInstances: (uid, query = {}) => listInstances(uid, query, shared),
  };
}

async function listInstances(uid, query = {}, dependencies = {}) {
  const ownerUid = requireUid(uid);
  const filters = normalizeFilters(query);
  const cursor = query.cursor ? decodeCursor(query.cursor, ownerUid, filters) : null;
  const firestore = dependencies.db || defaultDb;
  const [sessionDocs, activeRunDocs, cleanupErrorDocs] = await Promise.all([
    queryOwnerSessions(firestore, ownerUid),
    queryOwnerRuns(firestore, ownerUid, "status"),
    queryOwnerRuns(firestore, ownerUid, "cleanupState"),
  ]);

  const instances = new Map();
  for (const doc of [...activeRunDocs, ...cleanupErrorDocs]) {
    const run = doc.data() || {};
    if (run.ownerUid !== ownerUid) continue;
    const dto = toAutomationInstance(doc);
    if (dto && matchesFilters(dto, filters)) instances.set(dto.instanceKey, dto);
  }
  for (const doc of sessionDocs) {
    const session = doc.data() || {};
    if (session.ownerUid !== ownerUid) continue;
    const dto = toSessionInstance(doc);
    if (!dto || !matchesFilters(dto, filters)) continue;
    // Automation runs are authoritative when both the run and its runner
    // session are present. A missing run record remains visible for repair.
    if (dto.type === "automation" && instances.has(dto.instanceKey)) continue;
    instances.set(dto.instanceKey, dto);
  }

  let page = [...instances.values()].sort(compareInstances);
  if (cursor) page = page.filter((instance) => isAfterCursor(instance, cursor));
  const hasMore = page.length > filters.limit;
  const rows = page.slice(0, filters.limit);
  const last = rows[rows.length - 1];
  return {
    instances: rows.map(({instanceKey, ...instance}) => serialize(instance)),
    nextCursor: hasMore && last ? encodeCursor({
      version: 1,
      ownerUid,
      sort: "startedAt_desc_instanceKey_desc",
      startedAt: last.startedAt,
      instanceKey: last.instanceKey,
      ...filtersForCursor(filters),
    }) : null,
  };
}

async function queryOwnerSessions(firestore, ownerUid) {
  if (typeof firestore.collectionGroup !== "function") return [];
  let query = firestore.collectionGroup("sessions");
  if (typeof query.where === "function") {
    query = query.where("ownerUid", "==", ownerUid);
    query = query.where("status", "in", ACTIVE_SESSION_STATUSES);
  }
  const snapshot = await query.get();
  return snapshot.docs || [];
}

async function queryOwnerRuns(firestore, ownerUid, field) {
  if (typeof firestore.collection !== "function") return [];
  let query = firestore.collection("automationRuns");
  if (typeof query.where === "function") {
    query = query.where("ownerUid", "==", ownerUid);
    query = field === "status" ? query.where("status", "in", ACTIVE_RUN_STATUSES) :
      query.where("cleanupState", "==", "error");
  }
  const snapshot = await query.get();
  return snapshot.docs || [];
}

function toSessionInstance(doc) {
  const session = doc.data() || {};
  const workspaceId = cleanId(session.workspaceId);
  const sessionId = cleanId(doc.id || session.runnerSessionId);
  if (!workspaceId || !sessionId) return null;
  const automation = isAutomationRuntime(session);
  const runId = automation ? cleanId(session.automationRunId || session.runId || sessionId.replace(/^auto-/, "")) : null;
  const status = normalizeSessionStatus(session.status);
  if (!status) return null;
  return buildInstance({
    instanceKey: automation ? `automation:${runId || sessionId}` : `main:${workspaceId}:${sessionId}`,
    sessionId,
    runId,
    type: automation ? "automation" : "main",
    workspaceId,
    status,
    resources: session.resources || null,
    startedAt: firstTimestamp(session.runtimeStartedAt, session.startedAt, session.createdAt),
    heartbeatAt: firstTimestamp(
        session.automationExecutionHeartbeatAt,
        session.lastHeartbeatAt,
        session.lastActivityAt,
        session.updatedAt,
    ),
  });
}

function toAutomationInstance(doc) {
  const run = doc.data() || {};
  const runId = cleanId(doc.id || run.runId);
  const workspaceId = cleanId(run.workspaceId);
  if (!runId || !workspaceId) return null;
  const cleanupError = normalize(run.cleanupState) === "error";
  const status = cleanupError ? "cleanup-error" : normalize(run.status);
  if (!INSTANCE_STATUSES.includes(status)) return null;
  return buildInstance({
    instanceKey: `automation:${runId}`,
    sessionId: cleanId(run.sessionId),
    runId,
    type: "automation",
    workspaceId,
    status,
    resources: run.snapshot?.resources || run.resources || null,
    startedAt: firstTimestamp(run.startedAt, run.admittedAt, run.createdAt),
    heartbeatAt: firstTimestamp(run.executionHeartbeatAt, run.updatedAt, run.startedAt),
  });
}

function buildInstance({instanceKey, sessionId, runId, type, workspaceId, status, resources, startedAt, heartbeatAt}) {
  return {
    instanceKey,
    id: sessionId || runId,
    workspaceId,
    type,
    status,
    resources,
    startedAt: startedAt || null,
    heartbeatAt: heartbeatAt || null,
    runId: runId || null,
    sessionId: sessionId || null,
    stopTarget: type === "automation" ? {
      type: "automation-run",
      workspaceId,
      runId,
      sessionId: sessionId || null,
    } : {
      type: "main-session",
      workspaceId,
      sessionId,
    },
  };
}

function normalizeFilters(query = {}) {
  const status = normalizeFilter(query.status);
  if (status && !INSTANCE_STATUSES.includes(status)) throw httpError(400, "invalid_instance_status");
  const type = normalizeFilter(query.type);
  if (type && !["main", "automation"].includes(type)) throw httpError(400, "invalid_instance_type");
  return {
    limit: boundedPageSize(query.limit),
    workspaceId: validateFilterId(query.workspaceId, "workspace_id"),
    type,
    status,
  };
}

function filtersForCursor(filters) {
  return {workspaceId: filters.workspaceId, type: filters.type, status: filters.status};
}

function matchesFilters(instance, filters) {
  return (!filters.workspaceId || instance.workspaceId === filters.workspaceId) &&
    (!filters.type || instance.type === filters.type) &&
    (!filters.status || instance.status === filters.status);
}

function compareInstances(left, right) {
  const startedDifference = timestampMillis(right.startedAt) - timestampMillis(left.startedAt);
  return startedDifference || String(right.instanceKey).localeCompare(String(left.instanceKey));
}

function isAfterCursor(instance, cursor) {
  const started = timestampMillis(instance.startedAt);
  const cursorStarted = timestampMillis(cursor.startedAt);
  return started < cursorStarted || (started === cursorStarted && instance.instanceKey < cursor.instanceKey);
}

function decodeCursor(value, ownerUid, filters) {
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch (error) {
    throw httpError(400, "invalid_instance_cursor", error);
  }
  if (!cursor || cursor.version !== 1 || cursor.sort !== "startedAt_desc_instanceKey_desc" ||
      cursor.ownerUid !== ownerUid || cursor.workspaceId !== filters.workspaceId ||
      cursor.type !== filters.type || cursor.status !== filters.status ||
      typeof cursor.instanceKey !== "string" || !timestampMillis(cursor.startedAt)) {
    throw httpError(400, "invalid_instance_cursor");
  }
  return cursor;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function boundedPageSize(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

function validateFilterId(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(normalized)) throw httpError(400, `invalid_instance_${field}`);
  return normalized;
}

function normalizeFilter(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanId(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9._-]{1,200}$/.test(normalized) ? normalized : "";
}

function normalizeSessionStatus(value) {
  const status = normalize(value);
  if (["provisioning", "running", "stopping"].includes(status)) return status;
  if (["stop_failed", "delete_failed"].includes(status)) return "cleanup-error";
  return "";
}

function firstTimestamp(...values) {
  return values.find((value) => timestampMillis(value) > 0) || null;
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  if (value && typeof value._seconds === "number") return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function requireUid(value) {
  const uid = String(value || "").trim();
  if (!uid) throw httpError(401, "unauthenticated");
  return uid;
}

module.exports = {
  ACTIVE_RUN_STATUSES,
  ACTIVE_SESSION_STATUSES,
  DEFAULT_PAGE_SIZE,
  INSTANCE_STATUSES,
  MAX_PAGE_SIZE,
  createActiveInstancesService,
  listInstances,
  toAutomationInstance,
  toSessionInstance,
};
