"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const ARTIFACT_VERSION = 1;
const ARTIFACT_KIND = "mapache-automation-artifacts";
const CHUNK_RECORD_LIMIT = 200;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token|api[-_]?key|request[-_]?headers?)/i;

function createAutomationArtifactsService({
  admin,
  config = {},
  db,
  fsImpl = fs,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID(),
  storage,
} = {}) {
  const enabled = String(config.runtimeKind || "").trim().toLowerCase() === "automation" &&
    Boolean(config.workspaceId && (config.automationRunId || config.sessionId));
  return {
    enabled: () => enabled,
    capture: (options = {}) => {
      if (!enabled && options.allowUnmarked !== true) return Promise.resolve({enabled: false, skipped: true});
      return captureAutomationArtifacts({
        admin,
        config,
        db,
        fsImpl,
        now,
        randomId,
        storage,
        ...options,
      });
    },
  };
}

async function captureAutomationArtifacts({
  admin,
  bucketName,
  config = {},
  db,
  events,
  eventsPath,
  fsImpl = fs,
  generation,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID(),
  runId = config.automationRunId,
  sessionId = config.sessionId,
  storage,
  summary,
  transcript,
  transcriptPath,
  workspaceId = config.workspaceId,
  bootInstanceId,
  uploadObject,
} = {}) {
  const identity = validateIdentity({bootInstanceId, config, generation, runId, sessionId, workspaceId});
  const bucket = String(bucketName || config.bucketName || "").trim();
  if (!bucket || (!storage && typeof uploadObject !== "function")) {
    throw artifactError("automation_artifact_storage_unavailable", "Automation artifact storage is not configured");
  }

  const eventRecords = await readRecords({fsImpl, input: events, sourcePath: eventsPath, label: "events"});
  const transcriptRecords = await readRecords({fsImpl, input: transcript, sourcePath: transcriptPath, label: "transcript"});
  const normalizedSummary = sanitizeValue(summary === undefined ? {} : summary, "summary");
  const basePath = [normalizeRemotePart(config.prefix), "automation-runs", cleanSegment(runId), `v${ARTIFACT_VERSION}`]
      .filter(Boolean).join("/");
  const captureId = cleanSegment(randomId());
  const chunkRefs = [];
  for (const [kind, records] of [["events", eventRecords], ["transcript", transcriptRecords]]) {
    const chunks = chunkRecords(records);
    for (let index = 0; index < chunks.length; index++) {
      const content = encodeJsonl(chunks[index]);
      const objectPath = `${basePath}/${kind}/chunks/${captureId}-${String(index).padStart(6, "0")}.jsonl`;
      await saveImmutable({
        bucket,
        content,
        contentType: "application/x-ndjson",
        metadata: {mapacheArtifactKind: kind, mapacheArtifactRunId: identity.runId},
        objectPath,
        storage,
        uploadObject,
        admin,
      });
      chunkRefs.push({kind, index, ...objectReference({bucket, content, objectPath})});
    }
  }

  const summaryContent = Buffer.from(`${JSON.stringify(normalizedSummary, null, 2)}\n`, "utf8");
  const summaryPath = `${basePath}/summary/${captureId}.json`;
  await saveImmutable({
    bucket,
    content: summaryContent,
    contentType: "application/json",
    metadata: {mapacheArtifactKind: "summary", mapacheArtifactRunId: identity.runId},
    objectPath: summaryPath,
    storage,
    uploadObject,
    admin,
  });

  const manifest = {
    version: ARTIFACT_VERSION,
    kind: ARTIFACT_KIND,
    runId: identity.runId,
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    generation: identity.generation,
    bootInstanceId: identity.bootInstanceId,
    capturedAt: new Date(now()).toISOString(),
    chunks: chunkRefs,
    summary: objectReference({bucket, content: summaryContent, objectPath: summaryPath}),
    eventCount: eventRecords.length,
    transcriptCount: transcriptRecords.length,
  };
  const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestPath = `${basePath}/manifest-${captureId}.json`;
  await saveImmutable({
    bucket,
    content: manifestContent,
    contentType: "application/json",
    metadata: {mapacheArtifactKind: "manifest", mapacheArtifactRunId: identity.runId},
    objectPath: manifestPath,
    storage,
    uploadObject,
    admin,
  });
  const pointer = {
    version: ARTIFACT_VERSION,
    kind: ARTIFACT_KIND,
    runId: identity.runId,
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    generation: identity.generation,
    bootInstanceId: identity.bootInstanceId,
    manifest: objectReference({bucket, content: manifestContent, objectPath: manifestPath}),
    publishedAt: new Date(now()).toISOString(),
  };
  await publishPointer({admin, db, identity, pointer});
  return {ok: true, pointer, manifest, bucketName: bucket, basePath, captureId};
}

async function publishPointer({admin, db, identity, pointer}) {
  if (!db || typeof db.runTransaction !== "function") {
    throw artifactError("automation_artifact_coordination_unavailable", "Automation artifact authority is not configured");
  }
  const workspaceRef = db.collection("workspaces").doc(identity.workspaceId);
  const sessionRef = workspaceRef.collection("sessions").doc(identity.sessionId);
  const runRef = db.collection("automationRuns").doc(identity.runId);
  await db.runTransaction(async (transaction) => {
    const [workspaceSnap, sessionSnap, runSnap] = await Promise.all([
      transaction.get(workspaceRef),
      transaction.get(sessionRef),
      transaction.get(runRef),
    ]);
    if (!workspaceSnap.exists || !sessionSnap.exists) {
      throw artifactError("automation_artifact_authority_missing", "Automation artifact authority documents are missing");
    }
    const session = sessionSnap.data() || {};
    if (String(session.runtimeKind || "").trim().toLowerCase() !== "automation" ||
        String(session.automationRunId || "").trim() !== identity.runId ||
        String(session.runnerSessionId || sessionSnap.id) !== identity.sessionId) {
      throw artifactError("automation_artifact_authority_stale", "Automation artifact authority no longer matches this run");
    }
    if (identity.generation && Number(session.agentRuntimeGeneration) !== identity.generation) {
      throw artifactError("automation_artifact_authority_stale", "Automation artifact generation is stale");
    }
    if (identity.bootInstanceId && String(session.agentRuntimeBootInstanceId || "") !== identity.bootInstanceId) {
      throw artifactError("automation_artifact_authority_stale", "Automation artifact boot identity is stale");
    }
    transaction.update(sessionRef, {automationArtifactPointer: pointer, automationArtifactError: null});
    if (runSnap?.exists) {
      const existingPointers = runSnap.data()?.artifactPointers || {};
      transaction.update(runRef, {
        artifactPointers: {...existingPointers, automation: pointer},
        updatedAt: serverTimestamp(admin),
      });
    }
  });
}

async function readRecords({fsImpl, input, label, sourcePath}) {
  let value = input;
  if (sourcePath) value = await fsImpl.promises.readFile(sourcePath, "utf8");
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    const lines = String(value).split(/\r?\n/).filter((line) => line.trim());
    return lines.map((line, index) => {
      try {
        return sanitizeValue(JSON.parse(line), `${label} record ${index}`);
      } catch (error) {
        throw artifactError("automation_artifact_jsonl_invalid", `Invalid ${label} JSONL record ${index}`, error);
      }
    });
  }
  if (!Array.isArray(value)) throw artifactError("automation_artifact_records_invalid", `${label} records must be an array`);
  return value.map((record, index) => sanitizeValue(record, `${label} record ${index}`));
}

function chunkRecords(records) {
  const chunks = [];
  for (let index = 0; index < records.length; index += CHUNK_RECORD_LIMIT) {
    chunks.push(records.slice(index, index + CHUNK_RECORD_LIMIT));
  }
  return chunks;
}

function encodeJsonl(records) {
  const content = Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
  if (content.length > MAX_ARTIFACT_BYTES) throw artifactError("automation_artifact_chunk_too_large", "Automation artifact chunk exceeds its size limit");
  return content;
}

async function saveImmutable({admin, bucket, content, contentType, metadata, objectPath, storage, uploadObject}) {
  if (typeof uploadObject === "function") {
    await uploadObject({bucketName: bucket, content, contentType, metadata, objectPath});
    return;
  }
  await storage.bucket(bucket).file(objectPath).save(content, {
    ifGenerationMatch: 0,
    resumable: false,
    contentType,
    metadata: {metadata},
  });
}

function objectReference({bucket, content, objectPath}) {
  return {
    bucketName: bucket,
    objectPath,
    byteLength: content.length,
    sha256: sha256(content),
  };
}

function validateIdentity({bootInstanceId, config, generation, runId, sessionId, workspaceId}) {
  const rawRunId = String(runId || config.automationRunId || "").trim();
  const identity = {
    bootInstanceId: String(bootInstanceId || config.agentRuntimeBootInstanceId || "").trim(),
    generation: Number(generation || config.agentRuntimeGeneration || 0),
    runId: rawRunId,
    sessionId: String(sessionId || config.sessionId || "").trim(),
    workspaceId: String(workspaceId || config.workspaceId || "").trim(),
  };
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(identity.runId) || !identity.sessionId || !identity.workspaceId ||
      !Number.isSafeInteger(identity.generation) || identity.generation < 1) {
    throw artifactError("automation_artifact_identity_invalid", "Automation artifact identity is incomplete");
  }
  return identity;
}

function sanitizeValue(value, label = "artifact") {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (Array.isArray(value)) return value.map((item, index) => sanitizeValue(item, `${label}[${index}]`));
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const usageCount = label.endsWith(".usage") &&
        ["totalTokens", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].includes(key) &&
        Number.isSafeInteger(item) && item >= 0;
      if (SENSITIVE_KEY.test(key) && !usageCount) throw artifactError("automation_artifact_sensitive_field", `Sensitive field is not allowed in ${label}: ${key}`);
      result[String(key).slice(0, 200)] = sanitizeValue(item, `${label}.${key}`);
    }
    return result;
  }
  throw artifactError("automation_artifact_value_invalid", `Unsupported artifact value in ${label}`);
}

function serverTimestamp(admin) {
  return admin?.firestore?.FieldValue?.serverTimestamp ? admin.firestore.FieldValue.serverTimestamp() : new Date().toISOString();
}

function normalizeRemotePart(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function cleanSegment(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160) || "unknown";
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function artifactError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

module.exports = {
  ARTIFACT_KIND,
  ARTIFACT_VERSION,
  CHUNK_RECORD_LIMIT,
  MAX_ARTIFACT_BYTES,
  captureAutomationArtifacts,
  createAutomationArtifactsService,
  sanitizeValue,
  validateIdentity,
};
