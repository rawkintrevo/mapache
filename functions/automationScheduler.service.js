"use strict";

const crypto = require("node:crypto");

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {buildAutomationRun, normalizeRunSnapshot} = require("./automationValidation.helpers");
const {deterministicCronRunId} = require("./automationRuns.service");
const {
  formatLocalMinute,
  nextAutomationOccurrences,
  validateAutomationScheduleTimezone,
} = require("./automationSchedule.helpers");

const TICK_LATE_TOLERANCE_MS = 120 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_TICK = 10;

function createAutomationSchedulerService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    db: dependencies.db || defaultDb,
    featureEnabled: dependencies.featureEnabled,
    listDueDefinitions: dependencies.listDueDefinitions,
    maxPages: dependencies.maxPages,
    now: dependencies.now,
    wakeQueue: dependencies.wakeQueue || dependencies.wakeAutomationQueue,
  };
  return {
    runTick: (event = {}) => runAutomationSchedulerTick(event, shared),
    runAutomationSchedulerTick: (event = {}) => runAutomationSchedulerTick(event, shared),
  };
}

async function runAutomationSchedulerTick(event = {}, dependencies = {}) {
  const firestore = dependencies.db || dependencies.firestore || defaultDb;
  const now = dependencies.now || (() => new Date());
  const enabled = typeof dependencies.featureEnabled === "function" ?
    await dependencies.featureEnabled() : await automationFeatureEnabled(firestore);
  if (!enabled) return {skippedReason: "disabled", processed: 0, queued: 0, skipped: 0};

  const deliveredAt = asDate(now());
  const scheduledAt = tickDate(event, deliveredAt);
  const latenessMs = deliveredAt.getTime() - scheduledAt.getTime();
  if (latenessMs > TICK_LATE_TOLERANCE_MS) {
    return {skippedReason: "late_delivery", latenessMs, processed: 0, queued: 0, skipped: 0};
  }
  if (latenessMs < -TICK_LATE_TOLERANCE_MS) {
    return {skippedReason: "future_delivery", latenessMs, processed: 0, queued: 0, skipped: 0};
  }

  const definitions = await listDueDefinitions(scheduledAt, dependencies);
  const totals = {processed: 0, queued: 0, skipped: 0, missedRanges: 0, pages: definitions.pages};
  for (const definition of definitions.docs) {
    const result = await processDefinition(definition, scheduledAt, dependencies);
    totals.processed++;
    totals.queued += result.queued ? 1 : 0;
    totals.skipped += result.skipped || 0;
    totals.missedRanges += result.missedRange ? 1 : 0;
  }
  return totals;
}

async function processDefinition(definition, tickDate, dependencies = {}) {
  const firestore = dependencies.db || dependencies.firestore || defaultDb;
  const firestoreAdmin = dependencies.admin || dependencies.firestoreAdmin || defaultAdmin;
  const definitionRef = definition.ref || definition;
  const definitionId = String(definition.id || definitionRef.id || "").trim();
  const workspaceId = String(definition.workspaceId || parentWorkspaceId(definitionRef) || "").trim();
  if (!definitionId || !workspaceId) return {ignored: true};

  let result = {ignored: true};
  await firestore.runTransaction(async (transaction) => {
    const currentSnap = await transaction.get(definitionRef);
    if (!currentSnap.exists) return;
    const current = currentSnap.data() || {};
    if (current.enabled !== true || current.deleted === true) return;
    const workspaceRef = firestore.collection("workspaces").doc(workspaceId);
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists) return;
    const workspace = workspaceSnap.data() || {};
    const schedule = tickSchedule(current, tickDate);
    if (!schedule.nextFuture) return;

    const currentNext = current.nextRunAt ? asDate(current.nextRunAt) : null;
    const tickOccurrence = schedule.tickOccurrence;
    const tickOccurrenceDate = tickOccurrence ? asDate(tickOccurrence.utc) : null;
    const due = !currentNext || currentNext.getTime() <= tickDate.getTime();
    if (!due) return;

    const now = firestoreAdmin.firestore.FieldValue.serverTimestamp();
    const pendingRunId = String(current.pendingRunId || "").trim();
    const pendingRef = pendingRunId ? firestore.collection("automationRuns").doc(pendingRunId) : null;
    const pendingSnap = pendingRef ? await transaction.get(pendingRef) : null;
    const pending = pendingSnap?.exists ? pendingSnap.data() || {} : null;
    const existingRunId = tickOccurrence ? deterministicCronRunId(definitionId, tickOccurrence) : "";
    const existingRef = existingRunId ? firestore.collection("automationRuns").doc(existingRunId) : null;
    const existingSnap = existingRef ? await transaction.get(existingRef) : null;

    const nextUpdates = {nextRunAt: new Date(schedule.nextFuture.utc), updatedAt: now};
    let missedRange = false;
    if (currentNext && (!tickOccurrenceDate || currentNext.getTime() < tickOccurrenceDate.getTime())) {
      const summary = buildMissedRangeRun({
        definition: current,
        definitionId,
        ownerUid: current.ownerUid,
        snapshot: buildSnapshot(current, workspace),
        workspace,
        workspaceId,
        from: currentNext,
        to: tickOccurrenceDate || tickDate,
        now,
      });
      const summaryRef = firestore.collection("automationRuns").doc(summary.runId);
      const summarySnap = await transaction.get(summaryRef);
      if (!summarySnap.exists) transaction.set(summaryRef, summary);
      missedRange = true;
    }

    if (tickOccurrence && tickOccurrenceDate && currentNext && currentNext.getTime() > tickOccurrenceDate.getTime()) {
      transaction.update(definitionRef, nextUpdates);
      result = {ignored: false, missedRange};
      return;
    }

    if (!tickOccurrence || !tickOccurrenceDate) {
      transaction.update(definitionRef, nextUpdates);
      result = {ignored: false, missedRange};
      return;
    }

    if (!existingSnap?.exists) {
      const snapshot = buildSnapshot(current, workspace);
      if (pending && isPendingRunActive(pending)) {
        const skipped = buildRun({
          automationId: definitionId,
          ownerUid: current.ownerUid,
          occurrence: tickOccurrence,
          runId: existingRunId,
          snapshot,
          status: "skipped",
          skippedReason: "queue_full",
          workspaceId,
          now,
        });
        transaction.set(existingRef, skipped);
        result.skipped = 1;
      } else {
        const queued = buildRun({
          automationId: definitionId,
          ownerUid: current.ownerUid,
          occurrence: tickOccurrence,
          runId: existingRunId,
          snapshot,
          status: "queued",
          workspaceId,
          now,
        });
        transaction.set(existingRef, queued);
        nextUpdates.pendingRunId = existingRunId;
        result.queued = true;
      }
    }
    transaction.update(definitionRef, nextUpdates);
    result.ignored = false;
    result.missedRange = missedRange;
  });

  if (result.queued && typeof dependencies.wakeQueue === "function") {
    await dependencies.wakeQueue(workspaceId);
  }
  return result;
}

async function listDueDefinitions(tickDate, dependencies = {}) {
  if (typeof dependencies.listDueDefinitions === "function") {
    const result = await dependencies.listDueDefinitions(tickDate);
    return {docs: Array.isArray(result) ? result : result.docs || [], pages: result.pages || 1};
  }
  const firestore = dependencies.db || dependencies.firestore || defaultDb;
  if (typeof firestore.collectionGroup !== "function") return {docs: [], pages: 0};
  const docs = [];
  let pages = 0;
  const maxPages = Number.isSafeInteger(dependencies.maxPages) && dependencies.maxPages > 0 ?
    dependencies.maxPages : MAX_PAGES_PER_TICK;
  let cursor = null;
  while (pages < maxPages) {
    let query = firestore.collectionGroup("automations")
        .where("enabled", "==", true)
        .where("deleted", "==", false)
        .where("nextRunAt", "<=", tickDate)
        .orderBy("nextRunAt", "asc")
        .limit(PAGE_SIZE);
    if (cursor && typeof query.startAfter === "function") query = query.startAfter(cursor);
    const snap = await query.get();
    pages++;
    docs.push(...(snap.docs || []));
    if (!snap.docs || snap.docs.length < PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  // Definitions created/enabled since the last tick have no pointer yet. They
  // are bounded separately so enabling the feature never requires a catch-up
  // replay of old schedule occurrences.
  let unscheduled = firestore.collectionGroup("automations")
      .where("enabled", "==", true)
      .where("deleted", "==", false)
      .where("nextRunAt", "==", null)
      .limit(PAGE_SIZE);
  const unscheduledSnap = await unscheduled.get();
  const seen = new Set(docs.map((doc) => doc.ref?.path || doc.id));
  for (const doc of unscheduledSnap.docs || []) {
    const key = doc.ref?.path || doc.id;
    if (!seen.has(key)) docs.push(doc);
  }
  return {docs, pages};
}

async function automationFeatureEnabled(firestore) {
  const ref = firestore.collection("appConfig").doc("automations");
  const snap = await ref.get();
  return Boolean(snap.exists && snap.data()?.enabled === true);
}

function tickDate(event, fallback) {
  const source = event.scheduleTime || event.scheduledTime || event.timestamp || event.time;
  return source ? asDate(source) : fallback;
}

function tickSchedule(definition, tickDate) {
  const timezone = validateAutomationScheduleTimezone(definition.timezone);
  const local = formatLocalMinute(tickDate, timezone);
  const tickCandidate = nextAutomationOccurrences(definition.cron, timezone, {
    from: new Date(tickDate.getTime() - 60 * 1000),
    count: 1,
  })[0];
  const tickOccurrence = tickCandidate && tickCandidate.local === local ? tickCandidate : null;
  const nextFuture = nextAutomationOccurrences(definition.cron, timezone, {
    from: tickDate,
    count: 1,
  })[0];
  return {local, nextFuture, tickOccurrence};
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
  });
}

function buildRun({automationId, occurrence, ownerUid, runId, snapshot, status, skippedReason, workspaceId, now}) {
  const run = buildAutomationRun({}, {
    automationId,
    cleanupState: status === "skipped" ? "complete" : "pending",
    createdAt: now,
    ownerUid,
    queuedAt: now,
    runId,
    snapshot,
    status,
    trigger: "cron",
    updatedAt: now,
    workspaceId,
    skippedReason,
  });
  run.occurrence = occurrence;
  return run;
}

function buildMissedRangeRun({definition, definitionId, from, now, ownerUid, snapshot, to, workspaceId}) {
  const fromLocal = formatLocalMinute(from, definition.timezone);
  const toLocal = formatLocalMinute(to, definition.timezone);
  const summaryKey = `${definitionId}:missed:${fromLocal}:${toLocal}`;
  const runId = crypto.createHash("sha256").update(summaryKey).digest("hex");
  return buildRun({
    automationId: definitionId,
    occurrence: {
      local: toLocal,
      timezone: definition.timezone,
      skippedFrom: from.toISOString(),
      skippedTo: to.toISOString(),
    },
    ownerUid,
    runId,
    snapshot: snapshot || buildSnapshot(definition, {}),
    status: "skipped",
    skippedReason: "missed_range",
    workspaceId,
    now,
  });
}

function isPendingRunActive(run = {}) {
  return ["queued", "provisioning", "running", "stopping"].includes(String(run.status || "").trim().toLowerCase()) ||
    (String(run.cleanupState || "").trim().toLowerCase() === "pending" &&
      !["succeeded", "failed", "canceled", "interrupted", "skipped"].includes(String(run.status || "").trim().toLowerCase()));
}

function parentWorkspaceId(ref) {
  return ref?.parent?.parent?.id || ref?.parent?.parent?.parent?.parent?.id || "";
}

function asDate(value) {
  if (value && typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return new Date(value.getTime());
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_automation_tick_time");
  return date;
}

module.exports = {
  MAX_PAGES_PER_TICK,
  PAGE_SIZE,
  TICK_LATE_TOLERANCE_MS,
  automationFeatureEnabled,
  createAutomationSchedulerService,
  formatLocalMinute,
  listDueDefinitions,
  processDefinition,
  runAutomationSchedulerTick,
  tickSchedule,
};
