"use strict";

const {isAutomationRuntime} = require("./runtimePaths.helpers");

const ACTIVE_RUN_STATUSES = new Set(["provisioning", "running", "stopping"]);

/**
 * Resolves the run that is allowed to keep an admitted automation session
 * alive. The reaper must not infer liveness from browser sockets or the user
 * long-running toggle; it needs an owner/workspace/session-bound run record.
 */
function createAutomationAssignmentService({db} = {}) {
  return {
    resolveForSession: (session, sessionId) => resolveAutomationAssignment({db, session, sessionId}),
  };
}

async function resolveAutomationAssignment({db, session = {}, sessionId} = {}) {
  const normalizedSessionId = String(sessionId || session.id || "").trim();
  const runId = String(session.automationRunId || "").trim();
  if (!isAutomationRuntime(session) || !normalizedSessionId || !runId ||
      String(session.agentRuntimeAuthorityState || "").trim().toLowerCase() !== "admitted") {
    return {active: false, reason: "not_admitted"};
  }
  if (!db || typeof db.collection !== "function") return {active: false, reason: "coordination_unavailable"};
  try {
    const snapshot = await db.collection("automationRuns").doc(runId).get();
    if (!snapshot?.exists) return {active: false, reason: "run_missing"};
    const run = {runId: snapshot.id || runId, ...snapshot.data()};
    if (!isOwnerResolvedAssignment(session, normalizedSessionId, run)) {
      return {active: false, reason: "identity_mismatch"};
    }
    const status = String(run.status || "").trim().toLowerCase();
    if (!ACTIVE_RUN_STATUSES.has(status) || run.cleanupState === "complete") {
      return {active: false, reason: `status_${status || "unknown"}`};
    }
    return {active: true, runId, run};
  } catch (error) {
    return {active: false, reason: "coordination_unavailable", error};
  }
}

function isOwnerResolvedAssignment(session = {}, sessionId, run = {}) {
  return run.workspaceId === session.workspaceId &&
    run.ownerUid === session.ownerUid &&
    run.sessionId === sessionId &&
    run.runId === session.automationRunId;
}

module.exports = {
  ACTIVE_RUN_STATUSES,
  createAutomationAssignmentService,
  isOwnerResolvedAssignment,
  resolveAutomationAssignment,
};
