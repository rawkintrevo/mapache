"use strict";

const crypto = require("node:crypto");

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");
const {isMainRuntime} = require("./runtimePaths.helpers");

const SHARED_RUNTIME_EXECUTION_ROUTE = "shared-runtime-v1";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "interrupted"]);
const RUNNER_ACTIVE_STATUSES = new Set(["submitted", "running"]);
const STOPPED_SESSION_STATUSES = new Set(["stopped", "needs_image", "provision_failed"]);
const SHARED_RUNTIME_DISPATCH_TIMEOUT_MS = 300_000;

function createWorkspaceRequestRuntimeService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    createSession: dependencies.createSession,
    db: dependencies.db || defaultDb,
    requestRunnerJson: dependencies.requestRunnerJson,
    requireWorkspace: dependencies.requireWorkspace,
    restartSession: dependencies.restartSession,
    sessionCollection: dependencies.sessionCollection,
  };
  if (typeof shared.createSession !== "function" || typeof shared.restartSession !== "function") {
    throw new Error("Workspace request runtime requires normal session lifecycle dependencies.");
  }
  if (typeof shared.requestRunnerJson !== "function") {
    throw new Error("Workspace request runtime requires a runner request dependency.");
  }
  return {
    cancel: (runId) => cancelWorkspaceRequest(runId, shared),
    isSharedRequest: isSharedWorkspaceRequest,
    provision: (runId) => provisionWorkspaceRequest(runId, shared),
    reconcile: (runId) => reconcileWorkspaceRequest(runId, shared),
  };
}

async function provisionWorkspaceRequest(runId, dependencies = {}) {
  const run = await readRun(runId, dependencies);
  if (!run) return {skipped: "run_not_found", runId};
  if (!isSharedWorkspaceRequest(run)) return {skipped: "not_shared_runtime", runId};
  if (TERMINAL_STATUSES.has(normalize(run.status))) return {skipped: "terminal", runId};
  if (normalize(run.desiredOutcome) === "canceled") {
    await markOutcome(runId, "canceled", "workspace_request_canceled", {}, dependencies);
    return {canceled: true, runId};
  }

  const runtime = await ensureNormalRuntime(run, dependencies);
  if (!runtime.session || !isRunningSession(runtime.session)) {
    await markRuntimePending(runId, runtime, dependencies);
    return {provisioning: true, runId, sessionId: runtime.session?.id || null};
  }

  const claim = await claimDispatch(runId, runtime.session, dependencies);
  if (claim.action === "terminal") return {skipped: "terminal", runId};
  if (claim.action === "already_claimed") {
    await markOutcome(runId, "interrupted", "shared_runtime_dispatch_ambiguous", {}, dependencies);
    return {interrupted: true, runId, error: "shared_runtime_dispatch_ambiguous"};
  }

  let response;
  try {
    response = await dependencies.requestRunnerJson(runtime.session, "/workspace/requests", {
      method: "POST",
      body: {
        conversationTitle: requestTitle(run),
        modelRef: modelReference(run),
        prompt: String(run.snapshot?.prompt || run.workspaceRunRequest?.instructions || ""),
        runId,
        sourceWorkspaceId: run.workspaceRunRequest?.source?.id || run.sourceWorkspaceId || null,
        ticketId: run.ticketId || null,
      },
      failureError: "shared_runtime_dispatch_failed",
      unavailableError: "shared_runtime_dispatch_ambiguous",
      timeoutMs: SHARED_RUNTIME_DISPATCH_TIMEOUT_MS,
    });
  } catch (error) {
    await markOutcome(runId, "interrupted", "shared_runtime_dispatch_ambiguous", {}, dependencies);
    return {interrupted: true, runId, error: "shared_runtime_dispatch_ambiguous"};
  }

  if (!response?.ok || !response.conversationId) {
    await markOutcome(runId, "failed", "shared_runtime_dispatch_rejected", {}, dependencies);
    return {failed: true, runId, error: "shared_runtime_dispatch_rejected"};
  }

  await markDispatched(runId, runtime.session, response, dependencies);
  return {dispatched: true, runId, sessionId: runtime.session.id, conversationId: response.conversationId};
}

async function reconcileWorkspaceRequest(runId, dependencies = {}) {
  const run = await readRun(runId, dependencies);
  if (!run) return {skipped: "run_not_found", runId};
  if (!isSharedWorkspaceRequest(run)) return {skipped: "not_shared_runtime", runId};
  const status = normalize(run.status);
  if (TERMINAL_STATUSES.has(status)) return {skipped: "terminal", runId};
  const cancelRequested = status === "stopping" || normalize(run.desiredOutcome) === "canceled";
  if (status === "provisioning") return provisionWorkspaceRequest(runId, dependencies);

  const session = await readSession(run.workspaceId, run.sessionId, dependencies);
  if (!session || !isRunningSession(session)) {
    await markOutcome(runId, cancelRequested ? "canceled" : "interrupted",
        cancelRequested ? "workspace_request_canceled" : "shared_runtime_unavailable", {}, dependencies);
    return {interrupted: !cancelRequested, canceled: cancelRequested, runId};
  }

  let response;
  try {
    response = await dependencies.requestRunnerJson(session, `/workspace/requests/${encodeURIComponent(runId)}`, {
      failureError: "shared_runtime_status_failed",
      unavailableError: "shared_runtime_status_unavailable",
    });
  } catch (error) {
    await markOutcome(runId, cancelRequested ? "canceled" : "interrupted",
        cancelRequested ? "workspace_request_canceled" : "shared_runtime_status_unavailable", {}, dependencies);
    return {interrupted: !cancelRequested, canceled: cancelRequested, runId};
  }

  const request = response?.request || response;
  const terminal = runnerTerminalStatus(request);
  if (terminal) {
    await markOutcome(runId, terminal.status, terminal.errorCode, {
      conversationId: request.conversationId || run.conversationId,
      finalResult: request.state?.finalResult || request.finalResult,
      finalAnswer: request.state?.finalAnswer || request.finalAnswer,
    }, dependencies);
    return {completed: true, runId, status: terminal.status};
  }

  if (cancelRequested) {
    try {
      await dependencies.requestRunnerJson(session, `/workspace/requests/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: {},
        failureError: "shared_runtime_cancel_failed",
        unavailableError: "shared_runtime_cancel_ambiguous",
      });
    } catch {
      await markOutcome(runId, "interrupted", "shared_runtime_cancel_ambiguous", {}, dependencies);
      return {interrupted: true, runId};
    }
  }
  return {healthy: true, runId, status: RUNNER_ACTIVE_STATUSES.has(normalize(request.status)) ? request.status : status};
}

async function cancelWorkspaceRequest(runId, dependencies = {}) {
  const run = await readRun(runId, dependencies);
  if (!run || !isSharedWorkspaceRequest(run)) return {skipped: "not_shared_runtime", runId};
  const session = await readSession(run.workspaceId, run.sessionId, dependencies);
  if (!session || !isRunningSession(session)) {
    await markOutcome(runId, "canceled", "workspace_request_canceled", {}, dependencies);
    return {canceled: true, runId};
  }
  try {
    const response = await dependencies.requestRunnerJson(session, `/workspace/requests/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      body: {},
      failureError: "shared_runtime_cancel_failed",
      unavailableError: "shared_runtime_cancel_ambiguous",
    });
    const terminal = runnerTerminalStatus(response?.request || response);
    if (terminal) await markOutcome(runId, terminal.status, terminal.errorCode, {}, dependencies);
    return {requested: true, runId};
  } catch {
    await markOutcome(runId, "interrupted", "shared_runtime_cancel_ambiguous", {}, dependencies);
    return {interrupted: true, runId};
  }
}

async function ensureNormalRuntime(run, dependencies = {}) {
  const workspace = await dependencies.requireWorkspace(run.ownerUid, run.workspaceId);
  let session = await findCanonicalSession(workspace, run.workspaceId, dependencies);
  if (!session) {
    const created = await dependencies.createSession(run.ownerUid, run.workspaceId, {
      imageKey: "pi-chrome",
      name: `${workspace.name || "Workspace"} requests`,
      operationId: workspaceRequestOperationId(run.workspaceId),
      sessionType: "cloud",
    });
    session = await readSession(run.workspaceId, created.id, dependencies) || created;
  } else if (STOPPED_SESSION_STATUSES.has(normalize(session.status))) {
    try {
      session = await dependencies.restartSession(run.ownerUid, run.workspaceId, session.id);
    } catch (error) {
      if (!isRetryableRuntimeLifecycleError(error)) throw error;
      session = await readSession(run.workspaceId, session.id, dependencies) || session;
    }
  }
  return {session, workspace};
}

async function findCanonicalSession(workspace, workspaceId, dependencies = {}) {
  const snap = await dependencies.sessionCollection(workspaceId).get();
  const sessions = (snap.docs || []).map((doc) => ({id: doc.id, ...doc.data()})).filter(isMainRuntime);
  const canonicalId = String(workspace.canonicalSessionId || "").trim();
  const canonical = sessions.find((session) => session.id === canonicalId);
  if (canonical) return canonical;
  return sessions.sort((left, right) => timestampMillis(right.updatedAt) - timestampMillis(left.updatedAt))[0] || null;
}

async function readSession(workspaceId, sessionId, dependencies = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const snap = await dependencies.sessionCollection(workspaceId).doc(id).get();
  return snap.exists ? {id: snap.id, ...snap.data()} : null;
}

async function readRun(runId, dependencies = {}) {
  const id = String(runId || "").trim();
  if (!id) throw httpError(400, "invalid_workspace_request_run_id");
  const snap = await dependencies.db.collection("automationRuns").doc(id).get();
  return snap.exists ? {runId: snap.id, ...snap.data()} : null;
}

async function claimDispatch(runId, session, dependencies = {}) {
  const ref = dependencies.db.collection("automationRuns").doc(runId);
  let action = "claimed";
  await dependencies.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) {
      action = "terminal";
      return;
    }
    const run = snap.data() || {};
    if (TERMINAL_STATUSES.has(normalize(run.status))) {
      action = "terminal";
      return;
    }
    if (run.dispatchAcknowledgedAt || run.dispatchClaim) {
      action = "already_claimed";
      return;
    }
    const now = serverTimestamp(dependencies.admin);
    transaction.update(ref, {
      dispatchClaim: {
        id: crypto.randomUUID(),
        sessionId: session.id,
        generation: session.agentRuntimeGeneration || null,
        state: "claimed",
        claimedAt: now,
      },
      executionState: "dispatch_claimed",
      requestRuntimeState: "ready",
      updatedAt: now,
    });
  });
  return {action};
}

async function markDispatched(runId, session, response, dependencies = {}) {
  const now = serverTimestamp(dependencies.admin);
  await dependencies.db.collection("automationRuns").doc(runId).update({
    status: "running",
    sessionId: session.id,
    conversationId: String(response.conversationId),
    dispatchAcknowledgedAt: now,
    dispatchState: "acknowledged",
    executionStartedAt: now,
    executionState: "submitted",
    requestRuntimeState: "running",
    sharedRuntimeGeneration: session.agentRuntimeGeneration || null,
    startedAt: now,
    updatedAt: now,
  });
}

async function markRuntimePending(runId, runtime, dependencies = {}) {
  await dependencies.db.collection("automationRuns").doc(runId).update({
    sessionId: runtime.session?.id || null,
    requestRuntimeState: runtime.session ? normalize(runtime.session.status) : "starting",
    updatedAt: serverTimestamp(dependencies.admin),
  });
}

async function markOutcome(runId, status, errorCode, details = {}, dependencies = {}) {
  const normalized = TERMINAL_STATUSES.has(normalize(status)) ? normalize(status) : "interrupted";
  const now = serverTimestamp(dependencies.admin);
  await dependencies.db.runTransaction(async (transaction) => {
    const ref = dependencies.db.collection("automationRuns").doc(runId);
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const run = snap.data() || {};
    if (TERMINAL_STATUSES.has(normalize(run.status))) return;
    transaction.update(ref, {
      status: normalized,
      desiredOutcome: normalized,
      cleanupState: "pending",
      endedAt: now,
      updatedAt: now,
      executionEndedAt: now,
      executionOutcome: normalized,
      executionState: normalized,
      requestRuntimeState: normalized,
      ...(details.conversationId ? {conversationId: details.conversationId} : {}),
      ...(details.finalResult ? {finalResult: details.finalResult} : {}),
      ...(details.finalAnswer ? {finalAnswer: String(details.finalAnswer).slice(0, 32768)} : {}),
      ...(errorCode ? {executionErrorCode: errorCode, lastError: errorCode} : {}),
    });
  });
}

function runnerTerminalStatus(request = {}) {
  const status = normalize(request.status || request.state?.terminal);
  if (status === "succeeded") return {status, errorCode: null};
  if (status === "failed" || status === "interaction_required") return {status: "failed", errorCode: request.error || "shared_runtime_request_failed"};
  if (status === "canceled") return {status, errorCode: "workspace_request_canceled"};
  return null;
}

function isSharedWorkspaceRequest(run = {}) {
  return run.executionRoute === SHARED_RUNTIME_EXECUTION_ROUTE ||
    run.workspaceRunRequest?.executionRoute === SHARED_RUNTIME_EXECUTION_ROUTE;
}

function isRunningSession(session = {}) {
  return ["running", "ready"].includes(normalize(session.status)) && Boolean(String(session.serviceUrl || "").trim());
}

function isRetryableRuntimeLifecycleError(error) {
  return [409, 425, 429, 503].includes(Number(error?.status)) ||
    ["session_start_pending", "workspace_runtime_pending", "automation_requires_main_paused"].includes(String(error?.publicMessage || error?.code || ""));
}

function modelReference(run = {}) {
  const selection = run.snapshot?.modelSelection || run.workspaceRunRequest?.model;
  if (typeof selection === "string") return selection;
  const providerId = String(selection?.providerId || "").trim();
  const modelId = String(selection?.modelId || "").trim();
  return providerId && modelId ? `${providerId}/${modelId}` : "";
}

function requestTitle(run = {}) {
  const source = String(run.workspaceRunRequest?.source?.id || run.sourceWorkspaceId || "workspace").trim();
  return `Workspace request from ${source}`.slice(0, 120);
}

function workspaceRequestOperationId(workspaceId) {
  return `workspace-request-runtime-${crypto.createHash("sha256").update(String(workspaceId)).digest("hex").slice(0, 32)}`;
}

function serverTimestamp(admin) {
  return admin?.firestore?.FieldValue?.serverTimestamp?.() || new Date();
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

module.exports = {
  SHARED_RUNTIME_EXECUTION_ROUTE,
  createWorkspaceRequestRuntimeService,
  isSharedWorkspaceRequest,
  provisionWorkspaceRequest,
  reconcileWorkspaceRequest,
};
