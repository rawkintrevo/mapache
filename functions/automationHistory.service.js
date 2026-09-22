"use strict";

const crypto = require("node:crypto");

const {db: defaultDb, storage: defaultStorage} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");
const {AUTOMATION_RUN_STATUSES} = require("./automationValidation.helpers");

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_EVENT_PAGE_SIZE = 200;
const MAX_EVENT_PAGE_BYTES = 1024 * 1024;

function createAutomationHistoryService(dependencies = {}) {
  const shared = {
    db: dependencies.db || defaultDb,
    storage: dependencies.storage || defaultStorage,
  };
  return {
    getRun: (uid, runId) => getRun(uid, runId, shared),
    listEvents: (uid, runId, query = {}) => listEvents(uid, runId, query, shared),
    listRuns: (uid, query = {}) => listRuns(uid, query, shared),
  };
}

async function listRuns(uid, query = {}, dependencies = {}) {
  const normalizedUid = requireUid(uid);
  const firestore = dependencies.db || defaultDb;
  const limit = boundedPageSize(query.limit);
  const filters = {
    workspaceId: validatedFilterId(query.workspaceId, "workspace_id"),
    automationId: validatedFilterId(query.automationId, "automation_id"),
    status: validatedStatus(query.status),
  };
  const dateRange = validatedDateRange(query.from, query.to);
  const cursor = query.cursor ? decodeListCursor(query.cursor, normalizedUid, filters, dateRange) : null;
  if (filters.workspaceId) await assertWorkspaceFilterAvailable(normalizedUid, filters.workspaceId, firestore);
  if (cursor) await assertListCursor(cursor, normalizedUid, filters, dateRange, firestore);
  let source = firestore.collection("automationRuns");
  if (typeof source.where === "function") source = source.where("ownerUid", "==", normalizedUid);
  if (filters.workspaceId && typeof source.where === "function") source = source.where("workspaceId", "==", filters.workspaceId);
  if (filters.automationId && typeof source.where === "function") source = source.where("automationId", "==", filters.automationId);
  if (filters.status && typeof source.where === "function") source = source.where("status", "==", filters.status);
  if (dateRange.from !== null && typeof source.where === "function") source = source.where("createdAt", ">=", dateRange.fromValue);
  if (dateRange.to !== null && typeof source.where === "function") source = source.where("createdAt", "<=", dateRange.toValue);
  if (typeof source.orderBy === "function") {
    source = source.orderBy("createdAt", "desc");
    if (typeof source.orderBy === "function") source = source.orderBy("__name__", "desc");
  }
  if (cursor && typeof source.startAfter === "function") source = source.startAfter(new Date(cursor.createdAt), cursor.runId);
  if (typeof source.limit === "function") source = source.limit(limit + 1);
  const snap = await source.get();
  let docs = (snap.docs || []).filter((doc) => doc.data()?.ownerUid === normalizedUid);
  docs = docs.filter((doc) => !filters.workspaceId || doc.data()?.workspaceId === filters.workspaceId);
  docs = docs.filter((doc) => !filters.automationId || doc.data()?.automationId === filters.automationId);
  docs = docs.filter((doc) => !filters.status || doc.data()?.status === filters.status);
  docs = docs.filter((doc) => inDateRange(doc.data()?.createdAt, dateRange));
  docs.sort(compareRunDocs);
  if (cursor) docs = docs.filter((doc) => isAfterCursor(doc, cursor));
  const hasMore = docs.length > limit;
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  return {
    runs: page.map(toHistoryDto),
    nextCursor: hasMore && last ? encodeListCursor({
      createdAt: cursorTimestamp(last.data()?.createdAt),
      runId: last.id,
      ownerUid: normalizedUid,
      filters,
      dateRange,
    }) : null,
  };
}

async function getRun(uid, runId, dependencies = {}) {
  const normalizedUid = requireUid(uid);
  const ref = dependencies.db.collection("automationRuns").doc(cleanId(runId));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "automation_run_not_found");
  const run = snap.data() || {};
  if (run.ownerUid !== normalizedUid) throw httpError(403, "automation_run_forbidden");
  await assertRunWorkspaceAvailable(run, dependencies.db || defaultDb);
  return toHistoryDto(snap);
}

async function listEvents(uid, runId, query = {}, dependencies = {}) {
  const normalizedRunId = cleanId(runId);
  const run = await getOwnedRun(uid, normalizedRunId, dependencies);
  const pointer = run.artifactPointers?.automation || run.artifactPointers?.artifacts || null;
  if (!pointer) return {events: [], nextCursor: null, artifact: null};
  if (!isRunArtifactPath(pointer.manifest?.objectPath, normalizedRunId)) throw httpError(500, "automation_artifact_invalid");
  const manifest = await downloadJsonObject(pointer.manifest, dependencies.storage, "automation artifact manifest");
  validateManifest(manifest, pointer, normalizedRunId);
  const kindValue = String(query.kind || "all").trim().toLowerCase();
  if (!["all", "events", "transcript"].includes(kindValue)) throw httpError(400, "invalid_automation_event_kind");
  const kind = kindValue;
  const cursor = query.cursor ? decodeEventCursor(query.cursor) : {
    runId: normalizedRunId,
    kind,
    chunkIndex: 0,
    recordIndex: 0,
  };
  if (cursor.runId && cursor.runId !== normalizedRunId || cursor.kind && cursor.kind !== kind) {
    throw httpError(400, "invalid_automation_cursor");
  }
  const records = [];
  let bytes = 0;
  let nextCursor = null;
  const chunks = manifest.chunks.filter((chunk) => kind === "all" || chunk.kind === kind);
  if (cursor.chunkIndex > chunks.length || (cursor.chunkIndex === chunks.length && cursor.recordIndex !== 0)) {
    throw httpError(400, "invalid_automation_cursor");
  }
  for (let chunkIndex = cursor.chunkIndex; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const content = await downloadObject(chunk, dependencies.storage, `automation ${chunk.kind} chunk`);
    const lines = content.toString("utf8").split(/\r?\n/).filter(Boolean);
    const start = chunkIndex === cursor.chunkIndex ? cursor.recordIndex : 0;
    if (start > lines.length) throw httpError(400, "invalid_automation_cursor");
    for (let recordIndex = start; recordIndex < lines.length; recordIndex++) {
      const line = lines[recordIndex];
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (records.length >= MAX_EVENT_PAGE_SIZE || (records.length && bytes + lineBytes > MAX_EVENT_PAGE_BYTES)) {
        nextCursor = encodeEventCursor({runId: normalizedRunId, kind, chunkIndex, recordIndex});
        break;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw httpError(500, "automation_artifact_invalid", error);
      }
      records.push({kind: chunk.kind, record: sanitizeHistoryValue(record)});
      bytes += lineBytes;
    }
    if (nextCursor) break;
  }
  if (!nextCursor && chunks.length) {
    const lastChunk = chunks[chunks.length - 1];
    const lastContent = await downloadObject(lastChunk, dependencies.storage, `automation ${lastChunk.kind} chunk`);
    const lastLines = lastContent.toString("utf8").split(/\r?\n/).filter(Boolean);
    const reachedEnd = cursor.chunkIndex >= chunks.length - 1 && cursor.recordIndex >= lastLines.length;
    if (!reachedEnd && records.length >= MAX_EVENT_PAGE_SIZE) {
      nextCursor = encodeEventCursor({runId: normalizedRunId, kind, chunkIndex: chunks.length - 1, recordIndex: lastLines.length});
    }
  }
  return {
    events: records,
    nextCursor,
    artifact: {
      capturedAt: manifest.capturedAt || null,
      eventCount: manifest.eventCount || 0,
      transcriptCount: manifest.transcriptCount || 0,
    },
  };
}

async function getOwnedRun(uid, runId, dependencies) {
  const normalizedUid = requireUid(uid);
  const snap = await dependencies.db.collection("automationRuns").doc(runId).get();
  if (!snap.exists) throw httpError(404, "automation_run_not_found");
  const run = snap.data() || {};
  if (run.ownerUid !== normalizedUid) throw httpError(403, "automation_run_forbidden");
  await assertRunWorkspaceAvailable(run, dependencies.db || defaultDb);
  return run;
}

async function downloadJsonObject(reference, storage, label) {
  const content = await downloadObject(reference, storage, label);
  try {
    return JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw httpError(500, "automation_artifact_invalid", error);
  }
}

async function downloadObject(reference, storage, label) {
  if (!reference?.bucketName || !reference.objectPath || !storage) throw httpError(503, "automation_artifact_unavailable");
  const expectedPath = String(reference.objectPath);
  if (expectedPath.includes("..") || expectedPath.startsWith("/")) throw httpError(500, "automation_artifact_invalid");
  let content;
  try {
    [content] = await storage.bucket(reference.bucketName).file(expectedPath).download();
  } catch (error) {
    throw httpError(503, "automation_artifact_unavailable", error);
  }
  if (reference.byteLength !== undefined && Number(reference.byteLength) !== content.length) {
    throw httpError(500, "automation_artifact_checksum_mismatch");
  }
  if (reference.sha256 && sha256(content) !== reference.sha256) throw httpError(500, "automation_artifact_checksum_mismatch");
  return content;
}

function validateManifest(manifest, pointer, runId) {
  if (manifest.version !== 1 || manifest.kind !== "mapache-automation-artifacts" || manifest.runId !== runId ||
      manifest.sessionId !== pointer.sessionId || Number(manifest.generation) !== Number(pointer.generation) ||
      manifest.bootInstanceId !== pointer.bootInstanceId || !Array.isArray(manifest.chunks)) {
    throw httpError(500, "automation_artifact_invalid");
  }
  const baseMarker = `/automation-runs/${runId}/v1/`;
  for (const chunk of manifest.chunks) {
    if (!chunk || !["events", "transcript"].includes(chunk.kind) ||
        !isRunArtifactPath(chunk.objectPath, runId, baseMarker)) throw httpError(500, "automation_artifact_invalid");
  }
  if (!isRunArtifactPath(manifest.summary?.objectPath, runId, baseMarker)) throw httpError(500, "automation_artifact_invalid");
}

function isRunArtifactPath(objectPath, runId, marker = `/automation-runs/${runId}/v1/`) {
  const value = String(objectPath || "");
  const parts = value.split("/");
  const runIndex = parts.lastIndexOf("automation-runs");
  return Boolean(value && !value.startsWith("/") && !value.includes("..") &&
    runIndex >= 0 && parts[runIndex + 1] === runId && parts[runIndex + 2] === "v1" &&
    value.includes(marker));
}

function toHistoryDto(doc) {
  const run = typeof doc.data === "function" ? doc.data() || {} : doc || {};
  const id = doc.id || run.runId;
  const terminal = ["succeeded", "failed", "canceled", "interrupted", "skipped"].includes(normalize(run.status));
  const artifactPointer = run.artifactPointers?.automation || run.artifactPointers?.artifacts || null;
  return sanitizeHistoryValue({
    id,
    runId: run.runId || id,
    workspaceId: run.workspaceId,
    automationId: run.automationId,
    automationName: run.snapshot?.name || null,
    trigger: run.trigger,
    occurrence: run.occurrence || null,
    catchUpScheduledAt: run.catchUpScheduledAt || null,
    snapshot: run.snapshot,
    status: run.status,
    cleanupState: run.cleanupState,
    cleanupErrorCode: run.cleanupErrorCode || null,
    cleanupError: run.cleanupErrorCode || null,
    persistenceState: run.persistenceState || null,
    persistenceErrorCode: run.persistenceErrorCode || null,
    skippedReason: run.skippedReason || null,
    desiredOutcome: run.desiredOutcome || null,
    createdAt: run.createdAt,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    updatedAt: run.updatedAt,
    restartOfRunId: run.restartOfRunId || null,
    rootRunId: run.rootRunId || run.runId || id,
    retryOfRunId: run.retryOfRunId || null,
    attemptNumber: Number.isSafeInteger(run.attemptNumber) ? run.attemptNumber : 0,
    retryState: run.retryState || null,
    retryRunId: run.retryRunId || null,
    retryReason: run.retryErrorCode || run.retryCancellationReason || run.retryState || null,
    restartUrl: `/api/automation-runs/${encodeURIComponent(id)}/restart`,
    finalResult: run.finalResult || run.executionResult || run.executionOutcome || null,
    conversationId: run.conversationId || null,
    workspaceOutput: run.workspaceOutput ? {
      id: run.workspaceOutput.id,
      path: run.workspaceOutput.path,
      storageUri: `gs://${run.workspaceOutput.bucketName}/${run.workspaceOutput.prefix}/`,
    } : null,
    archiveAvailable: Boolean(artifactPointer),
    artifactAvailable: Boolean(artifactPointer),
    archiveCapturedAt: artifactPointer?.capturedAt || null,
    canStop: ["queued", "provisioning", "running"].includes(normalize(run.status)) &&
      normalize(run.cleanupState) !== "error",
    canRestart: terminal && normalize(run.cleanupState) === "complete",
    actions: {
      canStop: ["queued", "provisioning", "running"].includes(normalize(run.status)) &&
        normalize(run.cleanupState) !== "error",
      canRestart: terminal && normalize(run.cleanupState) === "complete",
    },
  });
}

function sanitizeHistoryValue(value) {
  if (typeof value === "string") return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 32768);
  if (Array.isArray(value)) return value.map(sanitizeHistoryValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeHistoryValue(item)]));
  return value;
}

function boundedPageSize(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

function cleanFilter(value) {
  return String(value || "").trim().slice(0, 200);
}

function validatedFilterId(value, field) {
  const filter = cleanFilter(value);
  if (!filter) return "";
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(filter)) throw httpError(400, `invalid_automation_${field}`);
  return filter;
}

function validatedStatus(value) {
  const status = cleanFilter(value).toLowerCase();
  if (!status) return "";
  if (!AUTOMATION_RUN_STATUSES.includes(status)) throw httpError(400, "invalid_automation_status");
  return status;
}

function validatedDateRange(from, to) {
  const start = parseDateFilter(from, "from");
  const end = parseDateFilter(to, "to");
  if (start !== null && end !== null && start > end) throw httpError(400, "invalid_automation_date_range");
  return {
    from: start,
    fromValue: start === null ? null : new Date(Date.parse(start)),
    to: end,
    toValue: end === null ? null : new Date(Date.parse(end)),
  };
}

function parseDateFilter(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Date.parse(String(value).trim());
  if (!Number.isFinite(parsed)) throw httpError(400, `invalid_automation_${field}`);
  return new Date(parsed).toISOString();
}

async function assertWorkspaceFilterAvailable(uid, workspaceId, firestore) {
  const snap = await firestore.collection("workspaces").doc(workspaceId).get();
  if (!snap.exists) throw httpError(404, "automation_workspace_not_found");
  const workspace = snap.data() || {};
  if (workspace.ownerUid !== uid) throw httpError(403, "automation_workspace_forbidden");
  if (workspace.deleted === true || ["deleting", "deleted"].includes(normalize(workspace.lifecycle || workspace.status))) {
    throw httpError(409, "automation_workspace_unavailable");
  }
}

async function assertRunWorkspaceAvailable(run, firestore) {
  if (!run.workspaceId) return;
  const snap = await firestore.collection("workspaces").doc(run.workspaceId).get();
  if (!snap.exists) return;
  const workspace = snap.data() || {};
  if (workspace.deleted === true || ["deleting", "deleted"].includes(normalize(workspace.lifecycle || workspace.status))) {
    throw httpError(409, "automation_workspace_unavailable");
  }
}

async function assertListCursor(cursor, uid, filters, dateRange, firestore) {
  const snap = await firestore.collection("automationRuns").doc(cursor.runId).get();
  if (!snap.exists) throw httpError(400, "invalid_automation_cursor");
  const run = snap.data() || {};
  if (run.ownerUid !== uid ||
      (filters.workspaceId && run.workspaceId !== filters.workspaceId) ||
      (filters.automationId && run.automationId !== filters.automationId) ||
      (filters.status && normalize(run.status) !== filters.status) ||
      !inDateRange(run.createdAt, dateRange) ||
      timestampMillis(run.createdAt) !== timestampMillis(cursor.createdAt)) {
    throw httpError(400, "invalid_automation_cursor");
  }
}

function inDateRange(value, range) {
  const timestamp = timestampMillis(value);
  if (range.from !== null && timestamp < Date.parse(range.from)) return false;
  if (range.to !== null && timestamp > Date.parse(range.to)) return false;
  return true;
}

function compareRunDocs(left, right) {
  const createdDifference = timestampMillis(right.data()?.createdAt) - timestampMillis(left.data()?.createdAt);
  if (createdDifference) return createdDifference;
  return String(right.id).localeCompare(String(left.id));
}

function isAfterCursor(doc, cursor) {
  const created = timestampMillis(doc.data()?.createdAt);
  const cursorCreated = timestampMillis(cursor.createdAt);
  return created < cursorCreated || (created === cursorCreated && String(doc.id) < String(cursor.runId));
}

function cursorTimestamp(value) {
  const millis = timestampMillis(value);
  if (!millis) throw httpError(500, "automation_cursor_timestamp_missing");
  return new Date(millis).toISOString();
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

function cleanId(value) {
  const id = String(value || "").trim();
  if (!id || !/^[A-Za-z0-9._-]{1,200}$/.test(id)) throw httpError(400, "invalid_automation_run_id");
  return id;
}

function requireUid(value) {
  const uid = String(value || "").trim();
  if (!uid) throw httpError(401, "unauthenticated");
  return uid;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function encodeListCursor({createdAt, runId, ownerUid, filters, dateRange}) {
  return encodeCursor({
    version: 1,
    sort: "createdAt_desc_runId_desc",
    createdAt,
    runId,
    ownerUid,
    ...filters,
    from: dateRange.from,
    to: dateRange.to,
  });
}

function encodeEventCursor(value) {
  return encodeCursor(value);
}

function decodeListCursor(value, ownerUid, filters, dateRange) {
  const cursor = decodeJsonCursor(value);
  if (cursor.version !== 1 || cursor.sort !== "createdAt_desc_runId_desc" || cursor.ownerUid !== ownerUid ||
      cursor.workspaceId !== filters.workspaceId || cursor.automationId !== filters.automationId ||
      cursor.status !== filters.status || cursor.from !== dateRange.from || cursor.to !== dateRange.to ||
      typeof cursor.createdAt !== "string" || !timestampMillis(cursor.createdAt)) {
    throw httpError(400, "invalid_automation_cursor");
  }
  return {createdAt: cursor.createdAt, runId: cleanId(cursor.runId)};
}

function decodeJsonCursor(value) {
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw new Error("invalid");
    return cursor;
  } catch (error) {
    throw httpError(400, "invalid_automation_cursor", error);
  }
}

function decodeEventCursor(value) {
  const cursor = decodeJsonCursor(value);
  if (typeof cursor.runId !== "string" || typeof cursor.kind !== "string" ||
      !Number.isSafeInteger(cursor.chunkIndex) || !Number.isSafeInteger(cursor.recordIndex) ||
      cursor.chunkIndex < 0 || cursor.recordIndex < 0) {
    throw httpError(400, "invalid_automation_cursor");
  }
  return cursor;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_EVENT_PAGE_BYTES,
  MAX_EVENT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  createAutomationHistoryService,
  getRun,
  listEvents,
  listRuns,
  sanitizeHistoryValue,
};
