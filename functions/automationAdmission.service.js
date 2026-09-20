"use strict";

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");
const {
  isActiveAutomationStatus,
  isTerminalAutomationStatus,
  transitionAutomationRun,
} = require("./automationState.helpers");
const {isAutomationRuntime} = require("./runtimePaths.helpers");

const DEFAULT_AUTOMATION_MAX_CONCURRENCY = 1;
const MAIN_STOPPED_STATES = new Set(["stopped", "needs_image", "provision_failed"]);
const AUTOMATION_EXCLUSION_FIELD = "automationMainExclusionRunId";
const AUTOMATION_ACTIVE_RUNS_FIELD = "automationActiveRunIds";

function createAutomationAdmissionService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    db: dependencies.db || defaultDb,
  };
  return {
    admitNextEligibleRun: (workspaceId) => admitNextEligibleRun(workspaceId, shared),
    assertMainAdmissionAllowed: (workspace) => assertMainAdmissionAllowed(workspace),
    releaseAfterCleanup: (runId, options = {}) => releaseAfterCleanup(runId, options, shared),
    releaseAutomationSlot: (runId, options = {}) => releaseAfterCleanup(runId, options, shared),
    wakeQueue: (workspaceId) => wakeQueue(workspaceId, shared),
  };
}

async function wakeQueue(workspaceId, dependencies = {}) {
  const admitted = [];
  while (true) {
    const result = await admitNextEligibleRun(workspaceId, dependencies);
    if (!result.admitted) return {workspaceId, admitted, reason: result.reason || "no_eligible_run"};
    admitted.push(result);
  }
}

async function admitNextEligibleRun(workspaceId, dependencies = {}) {
  const firestore = dependencies.db || dependencies.firestore || defaultDb;
  const firestoreAdmin = dependencies.admin || dependencies.firestoreAdmin || defaultAdmin;
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  if (!normalizedWorkspaceId) throw httpError(400, "invalid_workspace_id");

  let result = {admitted: false, workspaceId: normalizedWorkspaceId, reason: "no_eligible_run"};
  await firestore.runTransaction(async (transaction) => {
    const workspaceRef = firestore.collection("workspaces").doc(normalizedWorkspaceId);
    const runsQuery = automationRunsQuery(firestore, normalizedWorkspaceId);
    const sessionsRef = workspaceRef.collection("sessions");
    const [workspaceSnap, runsSnap, sessionsSnap] = await Promise.all([
      transaction.get(workspaceRef),
      transaction.get(runsQuery),
      transaction.get(sessionsRef),
    ]);
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");

    const workspace = workspaceSnap.data() || {};
    if (workspace.deleted === true || ["deleting", "deleted"].includes(normalize(workspace.lifecycle || workspace.status))) {
      result = {admitted: false, workspaceId: normalizedWorkspaceId, reason: "workspace_unavailable"};
      return;
    }

    const runDocs = Array.isArray(runsSnap?.docs) ? runsSnap.docs : [];
    const runs = runDocs.map((doc) => ({id: doc.id, ref: doc.ref, ...(doc.data() || {})}));
    const activeRuns = runs.filter(isReservedAutomationRun);
    const activeRunIds = activeRuns.map((run) => run.id).sort();
    const limit = automationConcurrencyLimit(workspace);
    if (activeRuns.length >= limit) {
      result = {
        admitted: false,
        workspaceId: normalizedWorkspaceId,
        reason: "concurrency_limit",
        activeCount: activeRuns.length,
        limit,
      };
      return;
    }

    const sessions = Array.isArray(sessionsSnap?.docs) ?
      sessionsSnap.docs.map((doc) => ({id: doc.id, ...(doc.data() || {})})) : [];
    const mainStopped = isMainFullyStopped(workspace, sessions);
    const exclusionRunId = String(workspace[AUTOMATION_EXCLUSION_FIELD] || "").trim();
    const candidates = runs
        .filter((run) => normalize(run.status) === "queued")
        .sort(compareQueuedRuns);
    const candidate = candidates.find((run) => {
      const allowParallel = runAllowsParallelWithMain(run);
      return allowParallel || (mainStopped && !exclusionRunId);
    });
    if (!candidate) {
      result = {
        admitted: false,
        workspaceId: normalizedWorkspaceId,
        reason: candidates.length ? (mainStopped ? "no_eligible_run" : "main_requires_pause") : "no_eligible_run",
        activeCount: activeRuns.length,
        limit,
      };
      return;
    }

    const candidateDefinitionRef = firestore.collection("workspaces")
        .doc(normalizedWorkspaceId)
        .collection("automations")
        .doc(String(candidate.automationId || ""));
    const candidateDefinitionSnap = await transaction.get(candidateDefinitionRef);
    const currentCandidate = candidateDefinitionSnap.exists ? candidateDefinitionSnap.data() || {} : null;
    const candidateAllowParallel = runAllowsParallelWithMain(candidate);
    const now = firestoreAdmin.firestore.FieldValue.serverTimestamp();
    const admissionUpdates = {
      admittedAt: now,
      automationSlot: {
        workspaceId: normalizedWorkspaceId,
        allowParallelWithMain: candidateAllowParallel,
        mainExclusion: !candidateAllowParallel,
        state: "held",
      },
      updatedAt: now,
    };
    const nextRun = transitionAutomationRun(candidate, "provisioning", admissionUpdates);
    transaction.update(candidate.ref, {status: nextRun.status, ...admissionUpdates});

    const workspaceUpdates = {
      [AUTOMATION_ACTIVE_RUNS_FIELD]: [...new Set([...activeRunIds, candidate.id])].sort(),
      updatedAt: now,
    };
    if (!candidateAllowParallel) {
      workspaceUpdates[AUTOMATION_EXCLUSION_FIELD] = candidate.id;
      workspaceUpdates.automationMainExclusionUpdatedAt = now;
    }
    transaction.update(workspaceRef, workspaceUpdates);
    if (currentCandidate && currentCandidate.pendingRunId === candidate.id) {
      transaction.update(candidateDefinitionRef, {pendingRunId: null, updatedAt: now});
    }

    result = {
      admitted: true,
      workspaceId: normalizedWorkspaceId,
      runId: candidate.id,
      status: "provisioning",
      allowParallelWithMain: candidateAllowParallel,
      mainExclusion: !candidateAllowParallel,
      activeCount: activeRuns.length + 1,
      limit,
    };
  });
  return result;
}

async function releaseAfterCleanup(runId, options = {}, dependencies = {}) {
  const firestore = dependencies.db || dependencies.firestore || defaultDb;
  const firestoreAdmin = dependencies.admin || dependencies.firestoreAdmin || defaultAdmin;
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedRunId) throw httpError(400, "invalid_automation_run_id");
  if (options.serviceAbsent !== true) {
    throw httpError(409, "automation_cleanup_not_confirmed");
  }

  let released = false;
  let workspaceId = "";
  await firestore.runTransaction(async (transaction) => {
    const runRef = firestore.collection("automationRuns").doc(normalizedRunId);
    const runSnap = await transaction.get(runRef);
    if (!runSnap.exists) return;
    const run = runSnap.data() || {};
    workspaceId = String(run.workspaceId || "").trim();
    if (!workspaceId || !isTerminalAutomationStatus(run.status) || normalize(run.cleanupState) !== "complete") return;
    const workspaceRef = firestore.collection("workspaces").doc(workspaceId);
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists) return;
    const workspace = workspaceSnap.data() || {};
    const activeRunIds = readActiveRunIds(workspace).filter((id) => id !== normalizedRunId);
    const updates = {
      [AUTOMATION_ACTIVE_RUNS_FIELD]: activeRunIds,
      updatedAt: firestoreAdmin.firestore.FieldValue.serverTimestamp(),
    };
    if (String(workspace[AUTOMATION_EXCLUSION_FIELD] || "").trim() === normalizedRunId) {
      updates[AUTOMATION_EXCLUSION_FIELD] = null;
      updates.automationMainExclusionUpdatedAt = firestoreAdmin.firestore.FieldValue.serverTimestamp();
    }
    transaction.update(workspaceRef, updates);
    transaction.update(runRef, {
      automationSlot: {...(run.automationSlot || {}), state: "released", releasedAt: updates.updatedAt},
      automationSlotReleasedAt: updates.updatedAt,
      updatedAt: updates.updatedAt,
    });
    released = true;
  });

  if (released && workspaceId) {
    await wakeQueue(workspaceId, dependencies);
  }
  return {released, workspaceId, runId: normalizedRunId};
}

function assertMainAdmissionAllowed(workspace = {}) {
  if (String(workspace[AUTOMATION_EXCLUSION_FIELD] || "").trim()) {
    throw httpError(409, "automation_requires_main_paused");
  }
  return true;
}

function isReservedAutomationRun(run = {}) {
  if (isAutomationRuntime(run)) return false;
  return isActiveAutomationStatus(run.status) ||
    (isTerminalAutomationStatus(run.status) && normalize(run.cleanupState) === "pending");
}

function runAllowsParallelWithMain(run = {}) {
  const value = run.allowParallelWithMain === undefined ? run.snapshot?.allowParallelWithMain : run.allowParallelWithMain;
  return value !== false;
}

function isMainFullyStopped(workspace = {}, sessions = []) {
  const admissionState = normalize(workspace.automationMainAdmissionState);
  if (String(workspace.automationMainAdmissionSessionId || "").trim() &&
      !["stopped", "released"].includes(admissionState)) return false;
  const mainSessions = sessions.filter((session) => !isAutomationRuntime(session));
  if (mainSessions.some((session) => !MAIN_STOPPED_STATES.has(normalize(session.status)))) return false;
  const activeSessionId = String(workspace.activeChromeSessionId || "").trim();
  if (!activeSessionId) return true;
  const activeSession = mainSessions.find((session) => session.id === activeSessionId);
  return Boolean(activeSession && MAIN_STOPPED_STATES.has(normalize(activeSession.status)));
}

function automationConcurrencyLimit(workspace = {}) {
  const limit = Number(workspace.automationMaxConcurrency);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_AUTOMATION_MAX_CONCURRENCY;
}

function readActiveRunIds(workspace = {}) {
  return Array.isArray(workspace[AUTOMATION_ACTIVE_RUNS_FIELD]) ?
    [...new Set(workspace[AUTOMATION_ACTIVE_RUNS_FIELD].map((id) => String(id).trim()).filter(Boolean))].sort() : [];
}

function compareQueuedRuns(left, right) {
  const leftCreated = timestampMillis(left.createdAt || left.queuedAt);
  const rightCreated = timestampMillis(right.createdAt || right.queuedAt);
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;
  return String(left.id).localeCompare(String(right.id));
}

function automationRunsQuery(firestore, workspaceId) {
  let query = firestore.collection("automationRuns");
  return typeof query.where === "function" ? query.where("workspaceId", "==", workspaceId) : query;
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

module.exports = {
  AUTOMATION_ACTIVE_RUNS_FIELD,
  AUTOMATION_EXCLUSION_FIELD,
  admitNextEligibleRun,
  assertMainAdmissionAllowed,
  createAutomationAdmissionService,
  isMainFullyStopped,
  isReservedAutomationRun,
  releaseAfterCleanup,
  runAllowsParallelWithMain,
  wakeQueue,
};
