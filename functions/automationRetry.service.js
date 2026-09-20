"use strict";

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");

const RETRY_DELAYS_MS = Object.freeze([5 * 60 * 1000, 15 * 60 * 1000]);
const CLAIM_TTL_MS = 10 * 60 * 1000;
const RETRY_PAGE_SIZE = 100;

function createAutomationRetryService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    db: dependencies.db || defaultDb,
    enqueueRetryRun: dependencies.enqueueRetryRun,
    now: dependencies.now || (() => Date.now()),
  };
  return {
    processDueRetries: () => processDueRetries(shared),
    scheduleRetry: (runId) => scheduleRetry(runId, shared),
  };
}

async function scheduleRetry(runId, dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const admin = dependencies.admin || defaultAdmin;
  const runRef = firestore.collection("automationRuns").doc(String(runId || "").trim());
  let result = {scheduled: false, runId: runRef.id, reason: "not_eligible"};
  await firestore.runTransaction(async (transaction) => {
    const snap = await transaction.get(runRef);
    if (!snap.exists) return;
    const run = snap.data() || {};
    const eligibility = retryEligibility(run);
    if (!eligibility.eligible) {
      result = {scheduled: false, runId: runRef.id, reason: eligibility.reason};
      return;
    }
    if (["scheduled", "enqueuing", "enqueued", "canceled", "exhausted"].includes(normalize(run.retryState))) {
      result = {scheduled: normalize(run.retryState) === "scheduled", runId: runRef.id, reason: normalize(run.retryState)};
      return;
    }
    const attemptNumber = currentAttempt(run) + 1;
    if (attemptNumber > eligibility.maximumRetries) {
      transaction.update(runRef, {retryState: "exhausted", updatedAt: serverTimestamp(admin)});
      result = {scheduled: false, runId: runRef.id, reason: "retry_limit"};
      return;
    }
    const delayMs = RETRY_DELAYS_MS[attemptNumber - 1];
    const retryNotBefore = new Date(nowMillis(dependencies) + delayMs);
    transaction.update(runRef, {
      retryState: "scheduled",
      retryAttemptNumber: attemptNumber,
      retryNotBefore,
      retryScheduledAt: serverTimestamp(admin),
      retryErrorCode: null,
      updatedAt: serverTimestamp(admin),
    });
    result = {scheduled: true, runId: runRef.id, attemptNumber, retryNotBefore};
  });
  return result;
}

async function processDueRetries(dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const now = nowMillis(dependencies);
  let query = firestore.collection("automationRuns");
  if (typeof query.where === "function") query = query.where("retryState", "in", ["scheduled", "enqueuing"]);
  if (typeof query.limit === "function") query = query.limit(RETRY_PAGE_SIZE);
  const snapshot = await query.get();
  const due = (snapshot.docs || []).filter((doc) => {
    const run = doc.data() || {};
    const state = normalize(run.retryState);
    return (state === "scheduled" && timestampMillis(run.retryNotBefore) <= now) ||
      (state === "enqueuing" && now - timestampMillis(run.retryClaimedAt) >= CLAIM_TTL_MS);
  });
  const result = {checked: due.length, enqueued: 0, deferred: 0, canceled: 0, errors: 0};
  for (const doc of due) {
    const claim = await claimRetry(doc.ref, dependencies);
    if (!claim) continue;
    try {
      if (typeof dependencies.enqueueRetryRun !== "function") throw new Error("retry_enqueue_unavailable");
      const retry = await dependencies.enqueueRetryRun({
        actor: {uid: claim.ownerUid},
        aid: claim.automationId,
        attemptNumber: claim.retryAttemptNumber,
        rootRunId: claim.rootRunId || claim.runId,
        retryOfRunId: claim.runId,
        trigger: "retry",
        wid: claim.workspaceId,
      });
      await doc.ref.update({
        retryState: "enqueued",
        retryRunId: retry?.id || retry?.runId || null,
        retryEnqueuedAt: serverTimestamp(dependencies.admin || defaultAdmin),
        retryErrorCode: null,
        updatedAt: serverTimestamp(dependencies.admin || defaultAdmin),
      });
      result.enqueued++;
    } catch (error) {
      const code = stableErrorCode(error);
      const canceled = code === "automation_retry_definition_unavailable" || code === "automation_deleted";
      await doc.ref.update({
        retryState: canceled ? "canceled" : "scheduled",
        retryClaimedAt: null,
        retryErrorCode: code,
        updatedAt: serverTimestamp(dependencies.admin || defaultAdmin),
      });
      if (canceled) result.canceled++;
      else if (code === "pending_run_exists") result.deferred++;
      else result.errors++;
    }
  }
  return result;
}

async function claimRetry(runRef, dependencies = {}) {
  const firestore = dependencies.db || defaultDb;
  const admin = dependencies.admin || defaultAdmin;
  let claimed = null;
  await firestore.runTransaction(async (transaction) => {
    const snap = await transaction.get(runRef);
    if (!snap.exists) return;
    const run = {runId: snap.id, ...(snap.data() || {})};
    const state = normalize(run.retryState);
    const now = nowMillis(dependencies);
    const eligible = state === "scheduled" && timestampMillis(run.retryNotBefore) <= now;
    const reclaimable = state === "enqueuing" && now - timestampMillis(run.retryClaimedAt) >= CLAIM_TTL_MS;
    if (!eligible && !reclaimable) return;
    transaction.update(runRef, {
      retryState: "enqueuing",
      retryClaimedAt: new Date(now),
      updatedAt: serverTimestamp(admin),
    });
    claimed = run;
  });
  return claimed;
}

function retryEligibility(run = {}) {
  const policy = normalize(run.retryPolicy || run.snapshot?.retryPolicy);
  const maximumRetries = Number.isSafeInteger(run.maximumRetries) ? run.maximumRetries :
    Number.isSafeInteger(run.snapshot?.maximumRetries) ? run.snapshot.maximumRetries : 0;
  if (normalize(run.status) !== "failed" || normalize(run.cleanupState) !== "complete") return {eligible: false, reason: "not_failed"};
  if (policy !== "safe" || run.replaySafe !== true && run.snapshot?.replaySafe !== true) {
    return {eligible: false, reason: "retry_not_opted_in"};
  }
  if (run.unknownOutcome === true || normalize(run.outcome) === "unknown" || normalize(run.executionOutcome) === "unknown") {
    return {eligible: false, reason: "unknown_outcome"};
  }
  return {eligible: true, maximumRetries};
}

function currentAttempt(run = {}) {
  return Number.isSafeInteger(run.attemptNumber) && run.attemptNumber >= 0 ? run.attemptNumber : 0;
}

function serverTimestamp(admin) {
  return admin.firestore.FieldValue.serverTimestamp();
}

function nowMillis(dependencies) {
  const value = typeof dependencies.now === "function" ? dependencies.now() : Date.now();
  return value instanceof Date ? value.getTime() : Number(value);
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

function stableErrorCode(error) {
  const code = normalize(error?.code || error?.publicMessage || error?.message || "retry_failed");
  return /^[a-z0-9_:-]{1,120}$/.test(code) ? code : "retry_failed";
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

module.exports = {
  CLAIM_TTL_MS,
  RETRY_DELAYS_MS,
  createAutomationRetryService,
  processDueRetries,
  retryEligibility,
  scheduleRetry,
};
