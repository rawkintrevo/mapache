"use strict";

const {httpError} = require("./backendUtils.helpers");
const {
  QA_FAULT_HARNESS_ID,
  QA_FAULTS,
  isQaFaultHarnessSession,
  normalizeQaAccessTtl,
} = require("./qaFaultHarness.helpers");

function createQaFaultHarnessService({requestRunnerJson, requireSession} = {}) {
  return {
    arm: (uid, workspaceId, sessionId, body) => requestFault(uid, workspaceId, sessionId, body, {requireSession, requestRunnerJson}),
    getStatus: (uid, workspaceId, sessionId) => getFaultStatus(uid, workspaceId, sessionId, {requireSession, requestRunnerJson}),
    reset: (uid, workspaceId, sessionId) => requestFault(uid, workspaceId, sessionId, {action: "reset"}, {requireSession, requestRunnerJson}),
  };
}

async function getFaultStatus(uid, workspaceId, sessionId, dependencies) {
  const session = await requireQaSession(uid, workspaceId, sessionId, dependencies);
  return dependencies.requestRunnerJson(session, "/qa/faults/status", {
    failureError: "qa_fault_status_failed",
    notFoundError: "qa_fault_harness_unavailable",
    unavailableError: "qa_fault_runner_unavailable",
  });
}

async function requestFault(uid, workspaceId, sessionId, body = {}, dependencies) {
  const session = await requireQaSession(uid, workspaceId, sessionId, dependencies);
  const action = String(body.action || "arm").trim().toLowerCase();
  if (!["arm", "revoke-writer", "force-loss", "reset"].includes(action)) {
    throw httpError(400, "qa_fault_action_unknown");
  }
  const payload = {action};
  if (action === "arm") {
    const fault = String(body.fault || "").trim().toLowerCase();
    if (!QA_FAULTS.includes(fault)) throw httpError(400, "qa_fault_unknown");
    payload.fault = fault;
    if (fault === "short-lived-access") payload.ttlMs = normalizeQaAccessTtl(body.ttlMs);
  }
  return dependencies.requestRunnerJson(session, "/qa/faults", {
    method: "POST",
    body: payload,
    failureError: "qa_fault_failed",
    notFoundError: "qa_fault_harness_unavailable",
    unavailableError: "qa_fault_runner_unavailable",
  });
}

async function requireQaSession(uid, workspaceId, sessionId, dependencies) {
  const result = await dependencies.requireSession(uid, workspaceId, sessionId);
  const session = {id: sessionId, ...result.sessionSnap.data()};
  if (!isQaFaultHarnessSession(result.workspace, session)) {
    throw httpError(404, "qa_fault_harness_unavailable");
  }
  return session;
}

module.exports = {
  QA_FAULT_HARNESS_ID,
  createQaFaultHarnessService,
};
