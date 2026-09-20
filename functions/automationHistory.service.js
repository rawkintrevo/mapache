"use strict";

const crypto = require("node:crypto");

const {db: defaultDb, storage: defaultStorage} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");

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
    workspaceId: cleanFilter(query.workspaceId),
    automationId: cleanFilter(query.automationId),
    status: cleanFilter(query.status),
  };
  let source = firestore.collection("automationRuns");
  if (typeof source.where === "function") source = source.where("ownerUid", "==", normalizedUid);
  if (filters.workspaceId && typeof source.where === "function") source = source.where("workspaceId", "==", filters.workspaceId);
  if (filters.automationId && typeof source.where === "function") source = source.where("automationId", "==", filters.automationId);
  if (filters.status && typeof source.where === "function") source = source.where("status", "==", filters.status);
  if (typeof source.orderBy === "function") {
    source = source.orderBy("createdAt", "desc");
    if (typeof source.orderBy === "function") source = source.orderBy("__name__", "desc");
  }
  if (typeof source.limit === "function") source = source.limit(limit + 1);
  if (query.cursor && typeof source.startAfter === "function") {
    const cursor = decodeCursor(query.cursor);
    source = source.startAfter(cursor.createdAt, cursor.runId);
  }
  const snap = await source.get();
  let docs = (snap.docs || []).filter((doc) => doc.data()?.ownerUid === normalizedUid);
  docs = docs.filter((doc) => !filters.workspaceId || doc.data()?.workspaceId === filters.workspaceId);
  docs = docs.filter((doc) => !filters.automationId || doc.data()?.automationId === filters.automationId);
  docs = docs.filter((doc) => !filters.status || doc.data()?.status === filters.status);
  const hasMore = docs.length > limit;
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  return {
    runs: page.map(toHistoryDto),
    nextCursor: hasMore && last ? encodeCursor({createdAt: last.data()?.createdAt || null, runId: last.id}) : null,
  };
}

async function getRun(uid, runId, dependencies = {}) {
  const normalizedUid = requireUid(uid);
  const ref = dependencies.db.collection("automationRuns").doc(cleanId(runId));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "automation_run_not_found");
  const run = snap.data() || {};
  if (run.ownerUid !== normalizedUid) throw httpError(403, "automation_run_forbidden");
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
  const kind = query.kind === "transcript" ? "transcript" : query.kind === "events" ? "events" : "all";
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
  for (let chunkIndex = cursor.chunkIndex; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const content = await downloadObject(chunk, dependencies.storage, `automation ${chunk.kind} chunk`);
    const lines = content.toString("utf8").split(/\r?\n/).filter(Boolean);
    const start = chunkIndex === cursor.chunkIndex ? cursor.recordIndex : 0;
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
  return sanitizeHistoryValue({
    id: doc.id || run.runId,
    runId: run.runId || doc.id,
    ownerUid: run.ownerUid,
    workspaceId: run.workspaceId,
    automationId: run.automationId,
    trigger: run.trigger,
    snapshot: run.snapshot,
    status: run.status,
    cleanupState: run.cleanupState,
    cleanupErrorCode: run.cleanupErrorCode || null,
    persistenceState: run.persistenceState || null,
    persistenceErrorCode: run.persistenceErrorCode || null,
    skippedReason: run.skippedReason || null,
    desiredOutcome: run.desiredOutcome || null,
    createdAt: run.createdAt,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    updatedAt: run.updatedAt,
    conversationId: run.conversationId || null,
    artifactPointers: run.artifactPointers || {},
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

function encodeEventCursor(value) {
  return encodeCursor(value);
}

function decodeCursor(value) {
  const cursor = decodeJsonCursor(value);
  if (!Object.prototype.hasOwnProperty.call(cursor, "runId")) throw httpError(400, "invalid_automation_cursor");
  return cursor;
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
