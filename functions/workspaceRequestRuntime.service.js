"use strict";

const crypto = require("node:crypto");

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");
const {isMainRuntime} = require("./runtimePaths.helpers");
const {normalizeModelCatalog, normalizeModelSelection, savedModelSelection} = require("./workspaceRequestModels.service");
const {classifyWorkspaceRequestFailure, errorDescriptor} = require("./workspaceRequestErrors.helpers");

const SHARED_RUNTIME_EXECUTION_ROUTE = "shared-runtime-v1";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "interrupted"]);
const STOPPED_SESSION_STATUSES = new Set(["stopped", "needs_image", "provision_failed"]);
const SHARED_RUNTIME_DISPATCH_TIMEOUT_MS = 300_000;
const SHARED_RUNTIME_DISPATCH_CLAIM_STALE_MS = SHARED_RUNTIME_DISPATCH_TIMEOUT_MS + 30_000;
const REPAIRABLE_DISPATCH_ERROR_CODES = new Set([
  "shared_runtime_dispatch_ambiguous",
  "shared_runtime_status_unavailable",
]);

function createWorkspaceRequestRuntimeService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    createSession: dependencies.createSession,
    db: dependencies.db || defaultDb,
    requestRunnerJson: dependencies.requestRunnerJson,
    requireWorkspace: dependencies.requireWorkspace,
    restartSession: dependencies.restartSession,
    sessionCollection: dependencies.sessionCollection,
    now: dependencies.now || (() => Date.now()),
  };
  if (typeof shared.createSession !== "function" || typeof shared.restartSession !== "function") {
    throw new Error("Workspace request runtime requires normal session lifecycle dependencies.");
  }
  if (typeof shared.requestRunnerJson !== "function") {
    throw new Error("Workspace request runtime requires a runner request dependency.");
  }
  return {
    cancel: (runId) => cancelWorkspaceRequest(runId, shared),
    discoverModels: (ownerUid, workspaceId) => discoverWorkspaceRequestModels(ownerUid, workspaceId, shared),
    isSharedRequest: isSharedWorkspaceRequest,
    provision: (runId) => provisionWorkspaceRequest(runId, shared),
    reconcile: (runId) => reconcileWorkspaceRequest(runId, shared),
  };
}

async function discoverWorkspaceRequestModels(ownerUid, workspaceId, dependencies = {}) {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  if (!normalizedWorkspaceId) throw httpError(400, "invalid_target_workspace_id");
  const runtime = await ensureNormalRuntime({ownerUid, workspaceId: normalizedWorkspaceId}, dependencies);
  if (!runtime.session || !isRunningSession(runtime.session)) {
    throw httpError(503, "workspace_request_model_discovery_unavailable");
  }
  let response;
  try {
    response = await dependencies.requestRunnerJson(runtime.session, "/workspace/models", {
      failureError: "workspace_request_model_discovery_failed",
      unavailableError: "workspace_request_model_discovery_unavailable",
      timeoutMs: 30_000,
    });
  } catch (error) {
    throw httpError(Number(error?.status) >= 400 ? error.status : 503,
        classifyWorkspaceRequestFailure(error, "workspace_request_model_discovery_unavailable"), error);
  }
  if (!response?.ok || !Array.isArray(response.models)) {
    throw httpError(503, "workspace_request_model_discovery_unavailable");
  }
  return {
    targetWorkspaceId: normalizedWorkspaceId,
    savedModelSelection: normalizeModelSelection(response.savedModelSelection) || savedModelSelection(runtime.workspace),
    models: normalizeModelCatalog(response.models),
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
  if (claim.action === "canceled") {
    await markOutcome(runId, "canceled", "workspace_request_canceled", {}, dependencies, claim);
    return {canceled: true, runId};
  }
  if (["active_claim", "acknowledged", "stale_claim"].includes(claim.action)) {
    return reconcileClaimedDispatch(run, runtime.session, claim, dependencies);
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
    await markDispatchObservation(runId, runtime.session, claim, {
      state: "ambiguous",
      errorCode: "shared_runtime_dispatch_ambiguous",
    }, dependencies);
    const observed = await reconcileClaimedDispatch(run, runtime.session, {
      ...claim,
      action: "active_claim",
    }, dependencies);
    if (observed.completed || observed.interrupted || observed.repaired || observed.running || observed.pending) return observed;
    return {pending: true, runId, error: "shared_runtime_dispatch_ambiguous"};
  }

  if (!response?.ok || !response.conversationId) {
    await markOutcome(runId, "failed", "shared_runtime_dispatch_rejected", {}, dependencies, claim);
    return {failed: true, runId, error: "shared_runtime_dispatch_rejected"};
  }

  const terminal = runnerTerminalStatus(response);
  if (terminal) {
    await markOutcome(runId, terminal.status, terminal.errorCode, runnerOutcomeDetails(response), dependencies, claim);
    return {completed: true, runId, status: terminal.status};
  }
  const acknowledged = await markDispatched(runId, runtime.session, response, dependencies, run, claim);
  if (!acknowledged) {
    const latest = await readRun(runId, dependencies);
    if (latest?.status === "canceled") return {canceled: true, runId};
    if (TERMINAL_STATUSES.has(normalize(latest?.status))) return {completed: true, runId, status: latest.status};
    return {pending: true, runId};
  }
  return {dispatched: true, runId, sessionId: runtime.session.id, conversationId: response.conversationId};
}

async function reconcileWorkspaceRequest(runId, dependencies = {}) {
  const run = await readRun(runId, dependencies);
  if (!run) return {skipped: "run_not_found", runId};
  if (!isSharedWorkspaceRequest(run)) return {skipped: "not_shared_runtime", runId};
  const status = normalize(run.status);
  if (TERMINAL_STATUSES.has(status)) {
    if (!isRepairableInterruptedRequest(run)) return {skipped: "terminal", runId};
    return repairInterruptedWorkspaceRequest(run, dependencies);
  }
  const cancelRequested = status === "stopping" || normalize(run.desiredOutcome) === "canceled";
  if (status === "provisioning") return provisionWorkspaceRequest(runId, dependencies);

  const session = await readSession(run.workspaceId, run.sessionId, dependencies);
  if (!session || !isRunningSession(session)) {
    if (cancelRequested) {
      await markOutcome(runId, "canceled", "workspace_request_canceled", {}, dependencies, dispatchExpectation(run, dependencies));
      return {canceled: true, runId};
    }
    await markDispatchObservation(runId, session || {id: run.sessionId}, dispatchExpectation(run, dependencies), {
      state: "ambiguous",
      errorCode: "shared_runtime_status_unavailable",
    }, dependencies);
    return {pending: true, runId, error: "shared_runtime_status_unavailable"};
  }

  const claim = dispatchExpectation(run, dependencies);
  const observed = await observeRunnerRequest(run, session, claim, dependencies);
  if (cancelRequested && !observed.completed && !observed.canceled) {
    return cancelObservedRequest(run, session, claim, dependencies);
  }
  return observed;
}

async function cancelWorkspaceRequest(runId, dependencies = {}) {
  const run = await readRun(runId, dependencies);
  if (!run || !isSharedWorkspaceRequest(run)) return {skipped: "not_shared_runtime", runId};
  const session = await readSession(run.workspaceId, run.sessionId, dependencies);
  const expectation = dispatchExpectation(run, dependencies);
  if (!session || !isRunningSession(session)) {
    await markOutcome(runId, "canceled", "workspace_request_canceled", {}, dependencies, expectation);
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
    if (terminal) await markOutcome(runId, terminal.status, terminal.errorCode, {
      conversationId: response?.request?.conversationId || response?.conversationId || run.conversationId,
      finalResult: response?.request?.state?.finalResult || response?.state?.finalResult,
      finalAnswer: response?.request?.state?.finalAnswer || response?.state?.finalAnswer,
      errorDetail: terminal.errorDetail,
      errorAction: terminal.errorAction,
      resolvedModel: response?.request?.modelRef || response?.modelRef || modelReference(run) || null,
    }, dependencies, expectation);
    return {requested: true, runId};
  } catch {
    await markDispatchObservation(runId, session, expectation, {
      state: "ambiguous",
      errorCode: "shared_runtime_cancel_ambiguous",
    }, dependencies);
    return {pending: true, runId, error: "shared_runtime_cancel_ambiguous"};
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
  let result = {action: "claimed"};
  await dependencies.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) {
      result = {action: "terminal"};
      return;
    }
    const run = snap.data() || {};
    if (TERMINAL_STATUSES.has(normalize(run.status))) {
      result = {action: "terminal"};
      return;
    }
    if (normalize(run.desiredOutcome) === "canceled" || normalize(run.status) === "stopping") {
      result = {action: "canceled"};
      return;
    }
    const existingClaim = normalizeDispatchClaim(run.dispatchClaim);
    if (run.dispatchAcknowledgedAt || ["acknowledged", "completed"].includes(normalize(run.dispatchState)) ||
        normalize(run.status) === "running") {
      result = dispatchClaimResult("acknowledged", run, existingClaim);
      return;
    }
    if (existingClaim) {
      const stale = dispatchClaimIsStale(existingClaim, session, dependencies);
      result = dispatchClaimResult(stale ? "stale_claim" : "active_claim", run, existingClaim, stale ? "claim_stale" : null);
      return;
    }
    const now = serverTimestamp(dependencies.admin);
    const claim = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      generation: session.agentRuntimeGeneration || null,
      state: "claimed",
      claimedAt: now,
    };
    transaction.update(ref, {
      dispatchClaim: claim,
      sessionId: session.id,
      sharedRuntimeGeneration: session.agentRuntimeGeneration || null,
      dispatchState: "claimed",
      executionState: "dispatch_claimed",
      requestRuntimeState: "ready",
      updatedAt: now,
    });
    result = dispatchClaimResult("claimed", {...run, dispatchClaim: claim}, claim);
  });
  return result;
}

async function markDispatched(runId, session, response, dependencies = {}, run = {}, expectation = {}, options = {}) {
  const now = serverTimestamp(dependencies.admin);
  let written = false;
  await dependencies.db.runTransaction(async (transaction) => {
    const ref = dependencies.db.collection("automationRuns").doc(runId);
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const current = snap.data() || {};
    if (TERMINAL_STATUSES.has(normalize(current.status)) || normalize(current.desiredOutcome) === "canceled" ||
        normalize(current.status) === "stopping") return;
    if (!claimMatches(current, expectation)) return;
    const sessionRef = dependencies.sessionCollection?.(current.workspaceId)?.doc(session.id);
    const sessionSnap = sessionRef ? await transaction.get(sessionRef) : null;
    if (sessionSnap && (!sessionSnap.exists || !isRunningSession({id: sessionSnap.id, ...sessionSnap.data()}) ||
        !sameRuntimeIdentity({sessionId: session.id, generation: session.agentRuntimeGeneration}, {id: sessionSnap.id, agentRuntimeGeneration: sessionSnap.data()?.agentRuntimeGeneration}))) return;
    const currentClaim = normalizeDispatchClaim(current.dispatchClaim);
    if (!options.observed && currentClaim && !sameRuntimeIdentity(currentClaim, session)) return;
    if (!options.observed && currentClaim && normalize(currentClaim.state) !== "claimed") return;
    const conversationId = String(response.conversationId || current.conversationId || "").trim();
    if (!conversationId) return;
    const nextClaim = currentClaim ? {
      ...currentClaim,
      ...(options.observed && !sameRuntimeIdentity(currentClaim, session) ? {
        reconciledFromSessionId: currentClaim.sessionId || null,
        reconciledFromGeneration: currentClaim.generation || null,
      } : {}),
      sessionId: session.id,
      generation: session.agentRuntimeGeneration || null,
      state: "acknowledged",
      acknowledgedAt: currentClaim.acknowledgedAt || now,
    } : null;
    transaction.update(ref, {
      status: "running",
      sessionId: session.id,
      conversationId,
      dispatchAcknowledgedAt: current.dispatchAcknowledgedAt || now,
      dispatchState: "acknowledged",
      executionStartedAt: current.executionStartedAt || now,
      executionState: "submitted",
      requestRuntimeState: "running",
      sharedRuntimeGeneration: session.agentRuntimeGeneration || null,
      requestedModel: modelReference(run) || current.requestedModel || null,
      resolvedModelSelection: response.modelRef || current.resolvedModelSelection || modelReference(run) || null,
      startedAt: current.startedAt || now,
      ...(nextClaim ? {dispatchClaim: nextClaim} : {}),
      updatedAt: now,
    });
    written = true;
  });
  return written;
}

async function markRuntimePending(runId, runtime, dependencies = {}) {
  await dependencies.db.collection("automationRuns").doc(runId).update({
    sessionId: runtime.session?.id || null,
    requestRuntimeState: runtime.session ? normalize(runtime.session.status) : "starting",
    updatedAt: serverTimestamp(dependencies.admin),
  });
}

async function markOutcome(runId, status, errorCode, details = {}, dependencies = {}, expectation = {}) {
  const normalized = TERMINAL_STATUSES.has(normalize(status)) ? normalize(status) : "interrupted";
  const now = serverTimestamp(dependencies.admin);
  let written = false;
  await dependencies.db.runTransaction(async (transaction) => {
    const ref = dependencies.db.collection("automationRuns").doc(runId);
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const run = snap.data() || {};
    if (TERMINAL_STATUSES.has(normalize(run.status))) return;
    if (!claimMatches(run, expectation)) return;
    const cancellationCommitted = normalize(run.desiredOutcome) === "canceled" ||
      normalize(run.status) === "stopping" && Boolean(run.cancellationRequestedAt);
    const effectiveStatus = cancellationCommitted ? "canceled" : normalized;
    const effectiveErrorCode = cancellationCommitted ? "workspace_request_canceled" : errorCode;
    const currentClaim = normalizeDispatchClaim(run.dispatchClaim);
    transaction.update(ref, {
      status: effectiveStatus,
      desiredOutcome: effectiveStatus,
      cleanupState: "pending",
      endedAt: now,
      updatedAt: now,
      executionEndedAt: now,
      executionOutcome: effectiveStatus,
      executionState: effectiveStatus,
      requestRuntimeState: effectiveStatus,
      ...(details.conversationId ? {conversationId: details.conversationId} : {}),
      ...(details.finalResult !== undefined ? {finalResult: details.finalResult} : {}),
      ...(effectiveStatus === "succeeded" && details.finalAnswer !== undefined && details.finalAnswer !== null ?
        {finalAnswer: String(details.finalAnswer).slice(0, 32768)} : {}),
      ...(effectiveErrorCode ? {
        executionErrorCode: effectiveErrorCode,
        executionErrorMessage: details.errorDetail || errorDescriptor(effectiveErrorCode).message,
        executionErrorAction: details.errorAction || errorDescriptor(effectiveErrorCode).action,
        lastError: effectiveErrorCode,
      } : {}),
      ...(!effectiveErrorCode ? {
        executionErrorCode: null,
        executionErrorMessage: null,
        executionErrorAction: null,
        lastError: null,
      } : {}),
      ...(details.resolvedModel ? {resolvedModelSelection: details.resolvedModel} : {}),
      ...(currentClaim ? {dispatchClaim: {...currentClaim, state: "completed", completedAt: now}} : {}),
      dispatchState: "completed",
    });
    written = true;
  });
  return written;
}

async function reconcileClaimedDispatch(run, session, claim, dependencies = {}) {
  const observed = await observeRunnerRequest(run, session, claim, dependencies);
  if (observed.completed || observed.interrupted || observed.running || observed.pending) return observed;
  return {pending: true, runId: run.runId};
}

async function observeRunnerRequest(run, session, expectation, dependencies = {}) {
  const statusResult = await readRunnerRequestStatus(session, run.runId, dependencies);
  if (statusResult.kind === "error") {
    await markDispatchObservation(run.runId, session, expectation, {
      state: "ambiguous",
      errorCode: statusResult.errorCode,
    }, dependencies);
    if (statusResult.notFound && expectation.action === "stale_claim") {
      const interrupted = await markOutcome(run.runId, "interrupted", "shared_runtime_dispatch_ambiguous", {}, dependencies, expectation);
      if (interrupted) return {interrupted: true, runId: run.runId, error: "shared_runtime_dispatch_ambiguous"};
    }
    return {pending: true, runId: run.runId, error: statusResult.errorCode};
  }

  const request = statusResult.request;
  if (request.runId && String(request.runId) !== String(run.runId)) {
    await markDispatchObservation(run.runId, session, expectation, {
      state: "ambiguous",
      errorCode: "shared_runtime_status_unavailable",
    }, dependencies);
    return {pending: true, runId: run.runId, error: "shared_runtime_status_unavailable"};
  }
  const terminal = runnerTerminalStatus(request);
  if (terminal) {
    const completed = await markOutcome(run.runId, terminal.status, terminal.errorCode,
        runnerOutcomeDetails(request, run), dependencies, expectation);
    if (completed) {
      const latest = await readRun(run.runId, dependencies);
      return {completed: true, runId: run.runId, status: latest?.status || terminal.status};
    }
    const latest = await readRun(run.runId, dependencies);
    return latest && TERMINAL_STATUSES.has(normalize(latest.status)) ?
      {completed: true, runId: run.runId, status: latest.status} :
      {pending: true, runId: run.runId};
  }

  const acknowledged = await markDispatched(run.runId, session, request, dependencies, run, expectation, {observed: true});
  if (acknowledged) {
    return {
      running: true,
      runId: run.runId,
      sessionId: session.id,
      conversationId: request.conversationId || run.conversationId || null,
    };
  }
  const latest = await readRun(run.runId, dependencies);
  if (latest?.status === "canceled") return {canceled: true, runId: run.runId};
  return latest && TERMINAL_STATUSES.has(normalize(latest.status)) ?
    {completed: true, runId: run.runId, status: latest.status} :
    {pending: true, runId: run.runId};
}

async function readRunnerRequestStatus(session, runId, dependencies = {}) {
  try {
    const response = await dependencies.requestRunnerJson(session, `/workspace/requests/${encodeURIComponent(runId)}`, {
      failureError: "shared_runtime_status_failed",
      unavailableError: "shared_runtime_status_unavailable",
    });
    if (response?.ok === false && !response.request && !response.status) {
      const errorCode = String(response.error || "shared_runtime_status_unavailable");
      return {
        kind: "error",
        errorCode: isNotFoundError(response) ? "shared_runtime_request_not_found" : errorCode,
        notFound: isNotFoundError(response),
      };
    }
    return {kind: "response", request: response?.request || response || {}};
  } catch (error) {
    const notFound = isNotFoundError(error);
    return {
      kind: "error",
      errorCode: notFound ? "shared_runtime_request_not_found" : "shared_runtime_status_unavailable",
      notFound,
    };
  }
}

async function cancelObservedRequest(run, session, expectation, dependencies = {}) {
  try {
    const response = await dependencies.requestRunnerJson(session, `/workspace/requests/${encodeURIComponent(run.runId)}/cancel`, {
      method: "POST",
      body: {},
      failureError: "shared_runtime_cancel_failed",
      unavailableError: "shared_runtime_cancel_ambiguous",
    });
    const request = response?.request || response || {};
    const terminal = runnerTerminalStatus(request);
    if (terminal) {
      const completed = await markOutcome(run.runId, terminal.status, terminal.errorCode,
          runnerOutcomeDetails(request, run), dependencies, expectation);
      if (completed) {
        const latest = await readRun(run.runId, dependencies);
        return {completed: true, runId: run.runId, status: latest?.status || terminal.status};
      }
      return {pending: true, runId: run.runId};
    }
    return {pending: true, runId: run.runId, cancelRequested: true};
  } catch {
    await markDispatchObservation(run.runId, session, expectation, {
      state: "ambiguous",
      errorCode: "shared_runtime_cancel_ambiguous",
    }, dependencies);
    return {pending: true, runId: run.runId, error: "shared_runtime_cancel_ambiguous"};
  }
}

async function markDispatchObservation(runId, session, expectation, observation = {}, dependencies = {}) {
  const now = serverTimestamp(dependencies.admin);
  await dependencies.db.runTransaction(async (transaction) => {
    const ref = dependencies.db.collection("automationRuns").doc(runId);
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const run = snap.data() || {};
    if (TERMINAL_STATUSES.has(normalize(run.status)) || !claimMatches(run, expectation)) return;
    transaction.update(ref, {
      dispatchStatusCheckedAt: now,
      dispatchStatusErrorCode: observation.errorCode || null,
      ...(observation.state ? {dispatchState: observation.state} : {}),
      updatedAt: now,
    });
  });
}

async function repairInterruptedWorkspaceRequest(run, dependencies = {}) {
  const sessionId = String(run.sessionId || run.dispatchClaim?.sessionId || "").trim();
  const session = await readSession(run.workspaceId, sessionId, dependencies);
  if (!session || !isRunningSession(session) || !matchingRuntimeGeneration(run, session)) {
    return {retained: true, runId: run.runId, repair: "awaiting_matching_runtime"};
  }
  const expectation = dispatchExpectation(run, dependencies);
  const statusResult = await readRunnerRequestStatus(session, run.runId, dependencies);
  if (statusResult.kind === "error") {
    return {retained: true, runId: run.runId, repair: "status_unavailable"};
  }
  const request = statusResult.request || {};
  if (!authoritativeRepairEvidence(run, session, request)) {
    return {retained: true, runId: run.runId, repair: "evidence_mismatch"};
  }
  const terminal = runnerTerminalStatus(request);
  const nextStatus = terminal?.status || "running";
  const repaired = await applyInterruptedRepair(run, session, request, nextStatus, terminal, expectation, dependencies);
  if (!repaired) return {retained: true, runId: run.runId, repair: "repair_race"};
  return {repaired: true, runId: run.runId, status: nextStatus};
}

async function applyInterruptedRepair(run, session, request, nextStatus, terminal, expectation, dependencies = {}) {
  const now = serverTimestamp(dependencies.admin);
  const runRef = dependencies.db.collection("automationRuns").doc(run.runId);
  const ticketId = String(run.ticketId || ticketReference(run) || "").trim();
  if (!ticketId) return false;
  let repaired = false;
  await dependencies.db.runTransaction(async (transaction) => {
    const runSnap = await transaction.get(runRef);
    const ticketRef = dependencies.db.collection("workspaceTickets").doc(ticketId);
    const ticketSnap = await transaction.get(ticketRef);
    const sessionRef = dependencies.sessionCollection?.(run.workspaceId)?.doc(session.id);
    const sessionSnap = sessionRef ? await transaction.get(sessionRef) : null;
    const current = runSnap.exists ? runSnap.data() || {} : {};
    if (!runSnap.exists || !ticketSnap.exists || sessionSnap && (!sessionSnap.exists ||
        !isRunningSession({id: sessionSnap.id, ...sessionSnap.data()}) ||
        !matchingRuntimeGeneration(current, {id: sessionSnap.id, ...sessionSnap.data()}))) return;
    const ticket = ticketSnap.data() || {};
    if (!isRepairableInterruptedRequest(current) || ticket.runId !== run.runId ||
        ticket.status === "canceled" || normalize(current.desiredOutcome) === "canceled" ||
        !claimMatches(current, expectation)) return;
    const currentClaim = normalizeDispatchClaim(current.dispatchClaim);
    const nextClaim = currentClaim ? {
      ...currentClaim,
      sessionId: session.id,
      generation: session.agentRuntimeGeneration || null,
      state: nextStatus === "running" ? "acknowledged" : "completed",
      repairedAt: now,
    } : null;
    const repairRecord = {
      state: "recovered",
      fromStatus: current.status,
      fromErrorCode: current.executionErrorCode || current.lastError || null,
      evidenceStatus: nextStatus,
      conversationId: request.conversationId || current.conversationId || null,
      sessionId: session.id,
      generation: session.agentRuntimeGeneration || null,
      repairedAt: now,
    };
    const sinkDelivery = resetTicketSinkDelivery(current.sinkDelivery);
    transaction.update(runRef, {
      status: nextStatus,
      desiredOutcome: nextStatus === "running" ? null : nextStatus,
      cleanupState: "pending",
      endedAt: nextStatus === "running" ? null : now,
      executionEndedAt: nextStatus === "running" ? null : now,
      executionOutcome: nextStatus === "running" ? null : nextStatus,
      executionState: nextStatus === "running" ? "submitted" : nextStatus,
      requestRuntimeState: nextStatus === "running" ? "running" : nextStatus,
      sessionId: session.id,
      sharedRuntimeGeneration: session.agentRuntimeGeneration || null,
      conversationId: request.conversationId || current.conversationId || null,
      dispatchAcknowledgedAt: current.dispatchAcknowledgedAt || now,
      dispatchState: nextStatus === "running" ? "acknowledged" : "completed",
      ...(request.state?.finalResult || request.finalResult ? {finalResult: request.state?.finalResult || request.finalResult} : {}),
      ...(request.state?.finalAnswer || request.finalAnswer ? {finalAnswer: String(request.state?.finalAnswer || request.finalAnswer).slice(0, 32768)} : {}),
      ...(terminal?.errorCode ? {
        executionErrorCode: terminal.errorCode,
        executionErrorMessage: terminal.errorDetail || errorDescriptor(terminal.errorCode).message,
        executionErrorAction: terminal.errorAction || errorDescriptor(terminal.errorCode).action,
        lastError: terminal.errorCode,
      } : {
        executionErrorCode: null,
        executionErrorMessage: null,
        executionErrorAction: null,
        lastError: null,
      }),
      ...(nextClaim ? {dispatchClaim: nextClaim} : {}),
      dispatchRepair: repairRecord,
      dispatchRepairHistory: [...(Array.isArray(current.dispatchRepairHistory) ? current.dispatchRepairHistory : []), repairRecord].slice(-8),
      sinkDelivery,
      updatedAt: now,
    });
    repaired = true;
  });
  return repaired;
}

function runnerOutcomeDetails(request = {}, run = {}) {
  return {
    conversationId: request.conversationId || run.conversationId,
    finalResult: request.state?.finalResult || request.finalResult,
    finalAnswer: request.state?.finalAnswer || request.finalAnswer,
    errorDetail: runnerTerminalStatus(request)?.errorDetail,
    errorAction: runnerTerminalStatus(request)?.errorAction,
    resolvedModel: request.modelRef || request.state?.modelRef || modelReference(run) || null,
  };
}

function dispatchClaimResult(action, run = {}, claim = null, staleReason = null) {
  return {
    action,
    claim,
    claimId: claim?.id || null,
    sessionId: run.sessionId || claim?.sessionId || null,
    generation: run.sharedRuntimeGeneration || claim?.generation || null,
    ...(staleReason ? {staleReason} : {}),
  };
}

function dispatchExpectation(run = {}, dependencies = {}) {
  const claim = normalizeDispatchClaim(run.dispatchClaim);
  return {
    action: claim && dispatchClaimIsStale(claim, {id: run.sessionId, agentRuntimeGeneration: run.sharedRuntimeGeneration}, dependencies) ? "stale_claim" : "existing",
    claim,
    claimId: claim?.id || null,
    sessionId: run.sessionId || claim?.sessionId || null,
    generation: run.sharedRuntimeGeneration || claim?.generation || null,
  };
}

function normalizeDispatchClaim(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !String(value.id || "").trim()) return null;
  return {...value, id: String(value.id).trim()};
}

function claimMatches(run = {}, expectation = {}) {
  const expectedId = String(expectation.claimId || expectation.claim?.id || "").trim();
  if (!expectedId) return true;
  if (String(run.dispatchClaim?.id || "").trim() !== expectedId) return false;
  const expectedSessionId = String(expectation.sessionId || expectation.claim?.sessionId || "").trim();
  if (expectedSessionId && run.sessionId && String(run.sessionId) !== expectedSessionId) return false;
  const expectedGeneration = expectation.generation ?? expectation.claim?.generation;
  if (expectedGeneration !== null && expectedGeneration !== undefined && expectedGeneration !== "" &&
      run.sharedRuntimeGeneration !== null && run.sharedRuntimeGeneration !== undefined &&
      Number(run.sharedRuntimeGeneration) !== Number(expectedGeneration)) return false;
  return true;
}

function sameRuntimeIdentity(claim = {}, session = {}) {
  if (claim.sessionId && String(claim.sessionId) !== String(session.id || "")) return false;
  if (claim.generation !== null && claim.generation !== undefined && session.agentRuntimeGeneration !== null &&
      session.agentRuntimeGeneration !== undefined && Number(claim.generation) !== Number(session.agentRuntimeGeneration)) return false;
  return true;
}

function matchingRuntimeGeneration(run = {}, session = {}) {
  const expected = run.sharedRuntimeGeneration || run.dispatchClaim?.generation;
  return expected === null || expected === undefined || expected === "" ||
    Number(expected) === Number(session.agentRuntimeGeneration);
}

function dispatchClaimIsStale(claim = {}, session = {}, dependencies = {}) {
  if (!sameRuntimeIdentity(claim, session)) return true;
  const claimedAt = timestampMillis(claim.claimedAt);
  const now = Number(dependencies.now?.() || Date.now());
  return claimedAt > 0 && now - claimedAt >= SHARED_RUNTIME_DISPATCH_CLAIM_STALE_MS;
}

function authoritativeRepairEvidence(run = {}, session = {}, request = {}) {
  if (!request || String(request.runId || "") !== String(run.runId || "")) return false;
  const expectedConversation = String(run.conversationId || "").trim();
  const observedConversation = String(request.conversationId || "").trim();
  if (expectedConversation && observedConversation && expectedConversation !== observedConversation) return false;
  if (!session.id || run.sessionId && String(run.sessionId) !== String(session.id)) return false;
  return matchingRuntimeGeneration(run, session);
}

function isRepairableInterruptedRequest(run = {}) {
  return isSharedWorkspaceRequest(run) && normalize(run.status) === "interrupted" &&
    REPAIRABLE_DISPATCH_ERROR_CODES.has(String(run.executionErrorCode || run.lastError || "").trim()) &&
    normalize(run.dispatchRepair?.state) !== "recovered";
}

function ticketReference(run = {}) {
  const sink = (run.workspaceRunRequest?.sinks || []).find((entry) => entry?.kind === "ticket_result");
  return sink?.reference || null;
}

function resetTicketSinkDelivery(sinkDelivery) {
  if (!sinkDelivery || typeof sinkDelivery !== "object" || Array.isArray(sinkDelivery)) return sinkDelivery || {};
  return Object.fromEntries(Object.entries(sinkDelivery).map(([key, value]) => {
    if (!key.startsWith("ticket_result:")) return [key, value];
    return [key, {...value, state: "pending", lastError: null}];
  }));
}

function isNotFoundError(value) {
  return Number(value?.status || value?.runnerHttpStatus) === 404 ||
    /not[_ -]?found|unknown request/i.test(String(value?.error || value?.code || value?.message || ""));
}

function runnerTerminalStatus(request = {}) {
  const status = normalize(request.state?.terminal || request.status);
  if (status === "succeeded") return {status, errorCode: null};
  if (status === "failed" || status === "interaction_required") {
    const detail = request.error || request.state?.finalError || request.state?.error || request.finalError;
    const errorCode = status === "interaction_required" ? "workspace_request_interaction_required" :
      classifyWorkspaceRequestFailure(detail, "shared_runtime_request_failed");
    const descriptor = errorDescriptor(errorCode, detail);
    return {status: "failed", errorCode, errorDetail: descriptor.message, errorAction: descriptor.action};
  }
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
  SHARED_RUNTIME_DISPATCH_CLAIM_STALE_MS,
  createWorkspaceRequestRuntimeService,
  discoverWorkspaceRequestModels,
  isSharedWorkspaceRequest,
  isRepairableInterruptedRequest,
  provisionWorkspaceRequest,
  reconcileWorkspaceRequest,
  runnerTerminalStatus,
};
