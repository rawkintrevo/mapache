"use strict";

const crypto = require("node:crypto");

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {httpError, serialize} = require("./backendUtils.helpers");
const {assertWorkspaceStorageMigrationAllowed} = require("./runtimeReservation.helpers");
const {
  AUTOMATION_RUN_STATUSES,
  buildAutomationRun,
  normalizeRunSnapshot,
  validateAutomationId,
  validateRunTrigger,
} = require("./automationValidation.helpers");

const TERMINAL_STATUSES = new Set([
  "succeeded", "failed", "canceled", "interrupted", "skipped",
]);
const ACTIVE_STATUSES = new Set(AUTOMATION_RUN_STATUSES.filter((status) => !TERMINAL_STATUSES.has(status)));
const LOCAL_MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

function createAutomationRunsService(dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const firestoreAdmin = dependencies.admin || defaultAdmin;
  const shared = {
    firestore,
    firestoreAdmin,
    requireWorkspace: dependencies.requireWorkspace,
    wakeQueue: dependencies.wakeAutomationQueue || dependencies.wakeQueue,
  };
  return {
    enqueueRun: (input) => enqueueRun(input, shared),
    restartRun: (actor, runId, options = {}) => restartRun(actor, runId, options, shared),
    cancelQueuedRun: (actor, runId) => cancelQueuedRun(actor, runId, shared),
  };
}

async function enqueueRun(input = {}, dependencies = {}) {
  const actorUid = requireActorUid(input.actor);
  const trigger = validateTrigger(input.trigger);
  const workspaceId = validateContextId(input.wid, "workspace_id");
  const automationId = validateContextId(input.aid, "automation_id");
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const occurrenceInput = input.occurrence;
  const restartOfRunId = input.restartOfRunId ? validateContextId(input.restartOfRunId, "run_id") : null;
  const retryOfRunId = input.retryOfRunId ? validateContextId(input.retryOfRunId, "run_id") : null;
  const firestore = dependencies.firestore || dependencies.db || defaultDb;
  const admin = dependencies.firestoreAdmin || dependencies.admin || defaultAdmin;
  const workspaceRef = firestore.collection("workspaces").doc(workspaceId);
  const definitionRef = workspaceRef.collection("automations").doc(automationId);
  const runId = trigger === "cron" ? deterministicCronRunId(automationId, occurrenceInput) :
    trigger === "retry" ? deterministicRetryRunId(input.rootRunId || retryOfRunId, input.attemptNumber) : crypto.randomUUID();
  const runRef = firestore.collection("automationRuns").doc(runId);
  const requestKeyHash = idempotencyKey ? requestKeyHashFor(actorUid, workspaceId, trigger, idempotencyKey) : null;
  const requestRef = requestKeyHash ? firestore.collection("automationRunRequests").doc(requestKeyHash) : null;
  const sourceRunRef = ["restart", "retry"].includes(trigger) ?
    firestore.collection("automationRuns").doc(trigger === "retry" ? retryOfRunId : restartOfRunId) : null;
  const now = serverTimestamp(admin);
  let response;

  await firestore.runTransaction(async (transaction) => {
    const workspaceSnap = await transaction.get(workspaceRef);
    const definitionSnap = await transaction.get(definitionRef);
    const sourceRunSnap = sourceRunRef ? await transaction.get(sourceRunRef) : null;
    const existingRunSnap = await transaction.get(runRef);
    const requestSnap = requestRef ? await transaction.get(requestRef) : null;
    const requestRunSnap = requestSnap?.exists && requestSnap.data()?.runId && requestSnap.data().runId !== runId ?
      await transaction.get(firestore.collection("automationRuns").doc(requestSnap.data().runId)) : null;
    const pendingRunId = definitionSnap.exists ? String(definitionSnap.data()?.pendingRunId || "").trim() : "";
    const pendingRunSnap = pendingRunId && pendingRunId !== runId ?
      await transaction.get(firestore.collection("automationRuns").doc(pendingRunId)) : null;

    const workspace = assertWorkspace(workspaceSnap, actorUid, workspaceId);
    assertWorkspaceStorageMigrationAllowed(workspace);
    const definition = definitionSnap.exists ? definitionSnap.data() || {} : null;
    let sourceRun = null;

    if (trigger === "restart" || trigger === "retry") {
      sourceRun = trigger === "retry" ?
        assertRetrySource(sourceRunSnap, actorUid, workspaceId, retryOfRunId) :
        assertRestartSource(sourceRunSnap, actorUid, workspaceId, restartOfRunId);
      if (trigger === "retry" && (!definitionSnap.exists || definition.ownerUid !== actorUid || definition.deleted === true)) {
        throw httpError(409, "automation_retry_definition_unavailable");
      }
      if (trigger === "restart" && !definition && sourceRun.automationId !== automationId) {
        throw httpError(409, trigger === "retry" ? "automation_retry_definition_mismatch" : "automation_restart_definition_mismatch");
      }
    } else {
      if (!definitionSnap.exists) throw httpError(404, "automation_not_found");
      if (definition.ownerUid !== actorUid) throw httpError(403, "automation_forbidden");
      if (definition.deleted === true) throw httpError(409, "automation_deleted");
    }

    const snapshot = sourceRun ? normalizeRunSnapshot(sourceRun.snapshot) : buildSnapshot(definition, workspace);
    const occurrence = normalizeOccurrence(trigger, occurrenceInput, snapshot);
    const requestDigest = digestRequest({
      actorUid,
      workspaceId,
      automationId,
      trigger,
      occurrence,
      restartOfRunId,
      retryOfRunId,
      attemptNumber: input.attemptNumber,
      snapshot,
    });

    if (existingRunSnap.exists) {
      const existing = existingRunSnap.data() || {};
      if (requestSnap && !requestRunSnap?.exists && requestSnap.data()?.runId === runId) {
        throw httpError(409, "automation_run_request_corrupt");
      }
      response = toRunDto(existingRunSnap);
      return;
    }

    if (requestSnap?.exists) {
      const request = requestSnap.data() || {};
      if (request.digest !== requestDigest) throw httpError(409, "idempotency_key_reused");
      if (!requestRunSnap?.exists) throw httpError(409, "automation_run_request_corrupt");
      response = toRunDto(requestRunSnap);
      return;
    }

    const pending = pendingRunSnap?.exists ? pendingRunSnap.data() || {} : null;
    const pendingIsActive = pending && ACTIVE_STATUSES.has(String(pending.status || "").toLowerCase());
    if (pendingIsActive) {
      if (!["cron", "catch_up"].includes(trigger)) {
        const error = httpError(409, "pending_run_exists");
        error.pendingRunId = pendingRunId;
        throw error;
      }
      const skipped = createRun({
        actorUid,
        automationId,
        occurrence,
        ownerUid: actorUid,
        restartOfRunId,
        retryOfRunId,
        rootRunId: input.rootRunId || sourceRun?.rootRunId || sourceRun?.runId || runId,
        attemptNumber: input.attemptNumber,
        runId,
        snapshot,
        status: "skipped",
        trigger,
        now,
        workspaceId,
        skippedReason: "queue_full",
        requestDigest,
      });
      transaction.set(runRef, skipped);
      if (requestRef) transaction.set(requestRef, buildRequestRecord({
        actorUid, automationId, digest: requestDigest, runId, trigger, workspaceId, now,
      }));
      response = toRunDto({id: runId, data: () => skipped});
      return;
    }

    const queued = createRun({
      actorUid,
      automationId,
      occurrence,
      ownerUid: actorUid,
      restartOfRunId,
      retryOfRunId,
      rootRunId: input.rootRunId || sourceRun?.rootRunId || sourceRun?.runId || runId,
      attemptNumber: input.attemptNumber,
      runId,
      snapshot,
      status: "queued",
      trigger,
      now,
      workspaceId,
      requestDigest,
    });
    transaction.set(runRef, queued);
    if (definitionSnap.exists && definition.deleted !== true) {
      transaction.update(definitionRef, {pendingRunId: runId, updatedAt: now});
    }
    if (requestRef) transaction.set(requestRef, buildRequestRecord({
      actorUid, automationId, digest: requestDigest, runId, trigger, workspaceId, now,
    }));
    response = toRunDto({id: runId, data: () => queued});
  });

  if (response?.status === "queued" && typeof dependencies.wakeQueue === "function") {
    await dependencies.wakeQueue(workspaceId);
    const latest = await runRef.get();
    if (latest.exists) response = toRunDto(latest);
  }

  return response;
}

async function restartRun(actor, runId, options = {}, dependencies = {}) {
  const firestore = dependencies.firestore || dependencies.db || defaultDb;
  const sourceRef = firestore.collection("automationRuns").doc(validateContextId(runId, "run_id"));
  const sourceSnap = await sourceRef.get();
  if (!sourceSnap.exists) throw httpError(404, "automation_run_not_found");
  const source = sourceSnap.data() || {};
  return enqueueRun({
    actor,
    aid: source.automationId,
    idempotencyKey: options.idempotencyKey,
    occurrence: null,
    restartOfRunId: sourceSnap.id,
    trigger: "restart",
    wid: source.workspaceId,
  }, dependencies);
}

async function cancelQueuedRun(actor, runId, dependencies = {}) {
  const actorUid = requireActorUid(actor);
  const normalizedRunId = validateContextId(runId, "run_id");
  const firestore = dependencies.firestore || dependencies.db || defaultDb;
  const admin = dependencies.firestoreAdmin || dependencies.admin || defaultAdmin;
  const runRef = firestore.collection("automationRuns").doc(normalizedRunId);
  let response;
  await firestore.runTransaction(async (transaction) => {
    const runSnap = await transaction.get(runRef);
    if (!runSnap.exists) throw httpError(404, "automation_run_not_found");
    const run = runSnap.data() || {};
    if (run.ownerUid !== actorUid) throw httpError(403, "automation_run_forbidden");
    const workspaceRef = firestore.collection("workspaces").doc(run.workspaceId);
    const definitionRef = workspaceRef.collection("automations").doc(run.automationId);
    const workspaceSnap = await transaction.get(workspaceRef);
    const definitionSnap = await transaction.get(definitionRef);
    assertWorkspace(workspaceSnap, actorUid, run.workspaceId);
    if (String(run.status || "").toLowerCase() !== "queued") {
      response = toRunDto(runSnap);
      return;
    }
    const now = serverTimestamp(admin);
    transaction.update(runRef, {
      status: "canceled",
      cleanupState: "complete",
      cancellationReason: "user_canceled",
      endedAt: now,
      updatedAt: now,
    });
    if (definitionSnap.exists && definitionSnap.data()?.pendingRunId === normalizedRunId) {
      transaction.update(definitionRef, {pendingRunId: null, updatedAt: now});
    }
    response = toRunDto({id: normalizedRunId, data: () => ({...run, status: "canceled", cleanupState: "complete", cancellationReason: "user_canceled"})});
  });
  if (response?.status === "canceled" && typeof dependencies.wakeQueue === "function") {
    await dependencies.wakeQueue(run.workspaceId);
  }
  return response;
}

function createRun({actorUid, automationId, occurrence, ownerUid, restartOfRunId, retryOfRunId, rootRunId, attemptNumber, runId, snapshot, status, trigger, now, workspaceId, skippedReason, requestDigest}) {
  const run = buildAutomationRun({}, {
    automationId,
    cleanupState: status === "skipped" ? "complete" : "pending",
    createdAt: now,
    ownerUid,
    queuedAt: now,
    restartOfRunId,
    retryOfRunId,
    rootRunId,
    attemptNumber: Number.isSafeInteger(attemptNumber) ? attemptNumber : 0,
    retryPolicy: snapshot.retryPolicy || "none",
    maximumRetries: Number.isSafeInteger(snapshot.maximumRetries) ? snapshot.maximumRetries : 0,
    replaySafe: snapshot.replaySafe === true,
    runId,
    snapshot,
    status,
    trigger,
    updatedAt: now,
    workspaceId,
    skippedReason,
  });
  run.ownerUid = actorUid;
  run.workspaceId = workspaceId;
  if (occurrence) run.occurrence = occurrence;
  if (requestDigest) run.requestDigest = requestDigest;
  return run;
}

function buildSnapshot(definition, workspace) {
  return normalizeRunSnapshot({
    name: definition.name,
    prompt: definition.prompt,
    definitionRevision: definition.revision,
    cron: definition.cron,
    timezone: definition.timezone,
    allowParallelWithMain: definition.allowParallelWithMain,
    modelSelection: definition.modelSelection,
    resources: definition.resources === null || definition.resources === undefined ? workspace.resources || null : definition.resources,
    missedRunPolicy: definition.missedRunPolicy || "skip",
    catchUpWindowMinutes: definition.catchUpWindowMinutes || 1440,
    retryPolicy: definition.retryPolicy || "none",
    maximumRetries: Number.isSafeInteger(definition.maximumRetries) ? definition.maximumRetries : 0,
    replaySafe: definition.replaySafe === true,
  });
}

function assertWorkspace(snapshot, actorUid, workspaceId) {
  if (!snapshot.exists) throw httpError(404, "workspace_not_found");
  const workspace = snapshot.data() || {};
  if (workspace.ownerUid !== actorUid) throw httpError(403, "workspace_forbidden");
  const lifecycle = String(workspace.lifecycle || workspace.status || "").trim().toLowerCase();
  if (workspace.deleted === true || ["deleting", "deleted"].includes(lifecycle)) throw httpError(409, "workspace_deleted");
  return workspace;
}


function assertRestartSource(snapshot, actorUid, workspaceId, runId) {
  if (!snapshot?.exists) throw httpError(404, "automation_run_not_found");
  const run = snapshot.data() || {};
  if (run.ownerUid !== actorUid) throw httpError(403, "automation_run_forbidden");
  if (run.workspaceId !== workspaceId) throw httpError(409, "automation_run_workspace_mismatch");
  if (!TERMINAL_STATUSES.has(String(run.status || "").toLowerCase())) throw httpError(409, "automation_run_active");
  if (!run.snapshot) throw httpError(409, "automation_run_snapshot_missing");
  return {...run, runId};
}

function assertRetrySource(snapshot, actorUid, workspaceId, runId) {
  if (!snapshot?.exists) throw httpError(404, "automation_run_not_found");
  const run = snapshot.data() || {};
  if (run.ownerUid !== actorUid) throw httpError(403, "automation_run_forbidden");
  if (run.workspaceId !== workspaceId) throw httpError(409, "automation_run_workspace_mismatch");
  if (String(run.status || "").toLowerCase() !== "failed" || String(run.cleanupState || "").toLowerCase() !== "complete") {
    throw httpError(409, "automation_retry_source_not_definite_failure");
  }
  if (!run.snapshot) throw httpError(409, "automation_run_snapshot_missing");
  return {...run, runId};
}

function normalizeOccurrence(trigger, value, snapshot) {
  if (!["cron", "catch_up"].includes(trigger)) return null;
  const source = typeof value === "string" ? {local: value} : value || {};
  const local = String(source.local || source.localMinute || "").trim();
  if (!LOCAL_MINUTE_PATTERN.test(local)) throw httpError(400, "invalid_automation_occurrence");
  const timezone = String(source.timezone || snapshot.timezone || "").trim();
  if (timezone !== snapshot.timezone) throw httpError(409, "automation_occurrence_timezone_mismatch");
  const occurrence = {local, timezone};
  if (source.utc !== undefined) {
    const utc = new Date(source.utc);
    if (Number.isNaN(utc.getTime())) throw httpError(400, "invalid_automation_occurrence");
    occurrence.utc = utc.toISOString();
  }
  return occurrence;
}

function deterministicCronRunId(automationId, occurrence) {
  const source = typeof occurrence === "string" ? occurrence : occurrence?.local || occurrence?.localMinute;
  if (!LOCAL_MINUTE_PATTERN.test(String(source || "").trim())) throw httpError(400, "invalid_automation_occurrence");
  return crypto.createHash("sha256").update(`${automationId}/${String(source).trim()}`).digest("hex");
}

function deterministicRetryRunId(rootRunId, attemptNumber) {
  const root = validateContextId(rootRunId, "root_run_id");
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 2) {
    throw httpError(400, "invalid_automation_retry_attempt");
  }
  return crypto.createHash("sha256").update(`${root}/retry/${attemptNumber}`).digest("hex");
}

function digestRequest(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function requestKeyHashFor(ownerUid, workspaceId, trigger, key) {
  return digestRequest({ownerUid, workspaceId, action: trigger, idempotencyKey: key});
}

function buildRequestRecord({actorUid, automationId, digest, runId, trigger, workspaceId, now}) {
  return {ownerUid: actorUid, workspaceId, automationId, trigger, digest, runId, createdAt: now, updatedAt: now};
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw httpError(400, "invalid_idempotency_key");
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw httpError(400, "invalid_idempotency_key");
  return normalized;
}

function validateTrigger(value) {
  try {
    return validateRunTrigger(value);
  } catch (error) {
    throw httpError(400, "invalid_automation_trigger", error);
  }
}

function validateContextId(value, field) {
  try {
    return validateAutomationId(String(value || "").trim(), field);
  } catch (error) {
    throw httpError(400, `invalid_${field}`, error);
  }
}

function requireActorUid(actor) {
  const uid = typeof actor === "string" ? actor : actor?.uid;
  if (!uid || typeof uid !== "string") throw httpError(401, "unauthenticated");
  return uid;
}

function serverTimestamp(admin) {
  return admin.firestore.FieldValue.serverTimestamp();
}

function toRunDto(source) {
  const id = source.id || source.runId;
  const data = typeof source.data === "function" ? source.data() || {} : source;
  const safe = {...data};
  delete safe.chromeProfileSeed;
  if (safe.chromeProfileInitialization) {
    safe.chromeProfileInitialization = safeChromeProfileInitialization(safe.chromeProfileInitialization);
  }
  return serialize({id, ...safe});
}

function safeChromeProfileInitialization(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    mode: String(value.mode || "").slice(0, 32),
    reason: String(value.reason || "").slice(0, 64),
    capturedAt: value.capturedAt || null,
    ageMs: Number.isFinite(value.ageMs) ? value.ageMs : null,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  buildSnapshot,
  cancelQueuedRun,
  createAutomationRunsService,
  deterministicRetryRunId,
  deterministicCronRunId,
  enqueueRun,
  normalizeOccurrence,
  restartRun,
};
