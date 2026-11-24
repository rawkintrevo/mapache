"use strict";

const {automationPrompt} = require("./automationStorage.helpers");

const AUTOMATION_ACTIVE_RUN_STATUSES = new Set(["provisioning", "running", "stopping"]);
const AUTOMATION_ACTIVE_SESSION_STATUSES = new Set(["provisioning", "running", "restarting", "resizing"]);
const AUTOMATION_TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "interrupted", "skipped"]);
const MAX_AUTOMATION_FINAL_ANSWER_LENGTH = 32768;

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STATUS_TIMEOUT_MS = 5_000;

/**
 * Drives the one browserless automation assignment owned by this runner boot.
 *
 * The Firestore claim is deliberately separate from upstream submission. Once
 * executionStartedAt is written, a later boot treats the run as interrupted
 * instead of submitting the prompt a second time. The prompt is only sent over
 * pi-web-ui's private Unix control socket and is never part of a process argv.
 */
function createAutomationExecutionService({
  admin,
  clearTimeoutImpl = clearTimeout,
  config = {},
  db,
  logger = console,
  now = () => Date.now(),
  piWebUi,
  createNativeRuntime,
  setTimeoutImpl = setTimeout,
  workspaceAuthority,
} = {}) {
  const native = config.runtimeProvider === "compute-engine" &&
    String(config.runtimeKind || "").trim().toLowerCase() === "main";
  const enabled = (String(config.runtimeKind || "").trim().toLowerCase() === "automation" || native) &&
    (config.agentRuntimeEnabled === true || config.agentUiVersion === "pi-web-ui-v1");
  const pollIntervalMs = positiveNumber(config.automationExecutionPollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const statusTimeoutMs = positiveNumber(config.automationExecutionStatusTimeoutMs, DEFAULT_STATUS_TIMEOUT_MS);
  let startPromise = null;
  let pollTimer = null;
  let stopped = false;
  let execution = null;
  let assignment = null;

  return {
    enabled: () => enabled,
    handleProcessExit,
    pollOnce,
    start,
    startRun,
    status,
    statusFor,
    stop,
    cancelRun,
  };

  async function start() {
    if (!enabled) return {enabled: false, skipped: true};
    if (native) return {enabled: true, skipped: "awaiting_assignment"};
    if (startPromise) return startPromise;
    if (execution) return status();
    assignment = {native: false, runId: config.automationRunId, sessionId: config.sessionId};
    stopped = false;
    startPromise = startInternal();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function startRun(runId) {
    if (!native) return {enabled: false, skipped: "not_vm_runtime"};
    const normalizedRunId = cleanId(runId);
    if (!normalizedRunId) throw automationError("automation_run_id_required");
    if (execution && execution.runId !== normalizedRunId) throw automationError("automation_run_busy");
    if (startPromise) return startPromise;
    if (execution) return status();
    assignment = {native: true, runId: normalizedRunId, sessionId: config.sessionId};
    stopped = false;
    startPromise = startInternal();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function startInternal() {
    assertAuthority();
    const claim = await claimAssignment();
    if (claim.action === "skip") return {enabled: true, skipped: claim.reason};
    if (claim.action === "interrupt") {
      execution = {
        bootInstanceId: claim.assignment.bootInstanceId,
        conversationId: null,
        generation: claim.assignment.generation,
        runId: claim.assignment.runId,
        terminal: null,
        submitted: false,
      };
      await writeOutcome("interrupted", "automation_execution_already_claimed", null, {allowStaleClaim: true});
      return {enabled: true, interrupted: true, reason: claim.reason};
    }

    execution = {
      bootInstanceId: claim.assignment.bootInstanceId,
      conversationId: null,
      generation: claim.assignment.generation,
      runId: claim.assignment.runId,
      terminal: null,
      submitted: false,
      adapter: null,
      runtime: null,
    };
    try {
      if (claim.assignment.native) {
        if (typeof createNativeRuntime !== "function") throw automationError("vm_automation_runtime_unavailable");
        execution.runtime = await createNativeRuntime({
          onExit: ({error} = {}) => void handleProcessExit({error}),
          runId: claim.assignment.runId,
        });
        execution.adapter = execution.runtime.process;
        await execution.adapter.start();
      } else {
        execution.adapter = piWebUi;
      }
      const response = await execution.adapter.startAutomation({
        modelRef: claim.assignment.modelRef || undefined,
        prompt: claim.assignment.native ? nativeAutomationPrompt(claim.assignment.prompt) : automationPrompt(claim.assignment.prompt, config),
        runId: claim.assignment.runId,
      });
      if (!response || response.ok !== true) {
        throw automationError(normalizeFailureCode(response?.error, "automation_submit_failed"));
      }
      execution.submitted = true;
      execution.conversationId = cleanId(response.conversationId) || null;
      await writeHeartbeat(response, "submitted");
      const outcome = normalizeOutcome(response);
      if (outcome) {
        await finish(outcome.status, outcome.errorCode, outcome.response);
        await disposeNativeRuntime();
      } else {
        schedulePoll();
      }
      return {
        enabled: true,
        started: true,
        runId: claim.assignment.runId,
        conversationId: execution.conversationId,
      };
    } catch (error) {
      const code = normalizeFailureCode(error?.code || error?.message, "automation_submit_failed");
      await writeOutcome("interrupted", code).catch((writeError) => {
        logger.warn?.("automation interruption write failed", safeError(writeError));
      });
      await disposeNativeRuntime();
      throw error;
    }
  }

  async function pollOnce() {
    if (!enabled || stopped || !execution || execution.terminal || !execution.submitted) return status();
    try {
      assertAuthority();
      const response = await bounded(
          Promise.resolve((execution.adapter || piWebUi).automationStatus(execution.runId)),
          statusTimeoutMs,
          "automation_status_timeout",
      );
      if (!response || response.ok !== true || (response.runId && response.runId !== execution.runId)) {
        throw automationError(normalizeFailureCode(response?.error, "automation_status_unavailable"));
      }
      execution.conversationId = cleanId(response.conversationId) || execution.conversationId;
      const outcome = normalizeOutcome(response);
      if (outcome) {
        await finish(outcome.status, outcome.errorCode, response);
        await disposeNativeRuntime();
      } else {
        await writeHeartbeat(response, "running");
        schedulePoll();
      }
    } catch (error) {
      const code = normalizeFailureCode(error?.code || error?.message, "automation_process_lost");
      await writeOutcome("interrupted", code).catch((writeError) => {
        logger.warn?.("automation interruption write failed", safeError(writeError));
      });
      await disposeNativeRuntime();
    }
    return status();
  }

  async function handleProcessExit({error} = {}) {
    if (!enabled || !execution || execution.terminal) return status();
    clearPollTimer();
    const code = normalizeFailureCode(error?.code, "automation_process_lost");
    await writeOutcome("interrupted", code).catch((writeError) => {
      logger.warn?.("automation process-loss write failed", safeError(writeError));
    });
    await disposeNativeRuntime();
    return status();
  }

  async function stop({cancel = false} = {}) {
    stopped = true;
    clearPollTimer();
    if (cancel && execution && !execution.terminal) {
      try {
        if (execution.submitted && typeof (execution.adapter || piWebUi)?.cancelAutomation === "function") {
          await bounded(
              Promise.resolve((execution.adapter || piWebUi).cancelAutomation(execution.runId)),
              statusTimeoutMs,
              "automation_cancel_timeout",
          );
        }
        await writeOutcome("canceled", "automation_canceled");
        await disposeNativeRuntime();
      } catch (error) {
        await writeOutcome("canceled", normalizeFailureCode(error?.code, "automation_cancel_failed"))
            .catch((writeError) => logger.warn?.("automation cancellation write failed", safeError(writeError)));
        await disposeNativeRuntime();
      }
    }
    return status();
  }

  async function cancelRun(runId) {
    const normalizedRunId = cleanId(runId);
    if (!native || !normalizedRunId) {
      return {ok: false, error: "automation_run_not_found"};
    }
    if (execution && execution.runId !== normalizedRunId) throw automationError("automation_run_busy");
    if (execution && !execution.terminal) return stop({cancel: true});
    if (execution?.terminal) {
      const terminal = execution.terminal;
      await disposeNativeRuntime();
      return {ok: true, runId: normalizedRunId, status: terminal, durable: true};
    }
    assignment = {native: true, runId: normalizedRunId, sessionId: config.sessionId};
    return cancelDurableRun(normalizedRunId);
  }

  async function cancelDurableRun(runId) {
    const refs = assignmentRefs();
    const authority = currentAuthority();
    let result = null;
    await db.runTransaction(async (transaction) => {
      const [workspaceSnap, sessionSnap, runSnap] = await Promise.all([
        transaction.get(refs.workspaceRef),
        transaction.get(refs.sessionRef),
        transaction.get(refs.runRef),
      ]);
      if (!workspaceSnap?.exists || !sessionSnap?.exists || !runSnap?.exists) {
        result = {ok: false, error: "automation_run_not_found"};
        return;
      }
      const workspace = workspaceSnap.data() || {};
      const session = sessionSnap.data() || {};
      const run = {runId, ...runSnap.data()};
      if (run.workspaceId !== config.workspaceId || run.sessionId !== refs.sessionRef.id ||
          run.ownerUid !== config.ownerUid || session.ownerUid !== run.ownerUid ||
          workspace.ownerUid !== run.ownerUid || workspace.backend !== "compute-engine" ||
          workspace.currentSessionId !== refs.sessionRef.id || workspace.generation !== authority.generation ||
          session.generation !== authority.generation || session.state !== "active" ||
          run.executionRoute !== "vm-native-v1") {
        result = {ok: false, error: "automation_run_not_found"};
        return;
      }
      const currentStatus = cleanId(run.status).toLowerCase();
      if (AUTOMATION_TERMINAL_STATUSES.has(currentStatus)) {
        result = {ok: true, runId, status: currentStatus, durable: true};
        return;
      }
      if (!AUTOMATION_ACTIVE_RUN_STATUSES.has(currentStatus)) {
        result = {ok: false, error: "automation_run_not_cancelable"};
        return;
      }
      const effectiveStatus = run.desiredOutcome === "interrupted" ? "interrupted" : "canceled";
      const timestamp = serverTimestamp();
      transaction.update(refs.runRef, {
        desiredOutcome: effectiveStatus,
        endedAt: timestamp,
        executionEndedAt: timestamp,
        executionHeartbeatAt: timestamp,
        executionOutcome: effectiveStatus,
        executionState: effectiveStatus,
        ...(effectiveStatus === "interrupted" ? {
          executionErrorCode: normalizeFailureCode(run.interruptionReason, "automation_interrupted"),
        } : {}),
        cleanupState: "pending",
        status: effectiveStatus,
        updatedAt: timestamp,
      });
      transaction.update(refs.sessionRef, {
        automationExecutionEndedAt: timestamp,
        automationExecutionHeartbeatAt: timestamp,
        automationExecutionOutcome: effectiveStatus,
        automationExecutionState: effectiveStatus,
        updatedAt: timestamp,
      });
      result = {ok: true, runId, status: effectiveStatus, durable: true};
    });
    return result || {ok: false, error: "automation_run_not_found"};
  }

  async function claimAssignment() {
    const refs = assignmentRefs();
    const authority = currentAuthority();
    return db.runTransaction(async (transaction) => {
      const [workspaceSnap, sessionSnap, runSnap] = await Promise.all([
        transaction.get(refs.workspaceRef),
        transaction.get(refs.sessionRef),
        transaction.get(refs.runRef),
      ]);
      const assignment = validateAssignment({authority, workspaceSnap, sessionSnap, runSnap, refs});
      if (assignment.runStatus === "succeeded" || AUTOMATION_TERMINAL_STATUSES.has(assignment.runStatus)) {
        return {action: "skip", reason: `status_${assignment.runStatus}`};
      }
      if (assignment.runStatus === "stopping" || assignment.desiredOutcome === "canceled") {
        return {action: "skip", reason: "cancellation_requested"};
      }
      if (!AUTOMATION_ACTIVE_RUN_STATUSES.has(assignment.runStatus)) {
        throw automationError("automation_assignment_not_active");
      }
      if (assignment.executionStartedAt) {
        return {action: "interrupt", assignment, reason: "execution_started"};
      }

      const timestamp = serverTimestamp();
      transaction.update(refs.runRef, {
        executionBootInstanceId: assignment.bootInstanceId,
        executionGeneration: assignment.generation,
        executionHeartbeatAt: timestamp,
        executionState: "claimed",
        executionStartedAt: timestamp,
        updatedAt: timestamp,
      });
      transaction.update(refs.sessionRef, {
        automationExecutionBootInstanceId: assignment.bootInstanceId,
        automationExecutionGeneration: assignment.generation,
        automationExecutionHeartbeatAt: timestamp,
        automationExecutionState: "claimed",
        updatedAt: timestamp,
      });
      return {action: "claim", assignment};
    });
  }

  async function writeHeartbeat(response, state) {
    if (!execution || execution.terminal) return false;
    const refs = assignmentRefs();
    const timestamp = serverTimestamp();
    return db.runTransaction(async (transaction) => {
      const [sessionSnap, runSnap] = await Promise.all([
        transaction.get(refs.sessionRef),
        transaction.get(refs.runRef),
      ]);
      if (!sameExecutionIdentity(sessionSnap, runSnap)) return false;
      const run = runSnap.data() || {};
      if (AUTOMATION_TERMINAL_STATUSES.has(String(run.status || "").trim().toLowerCase())) return false;
      const conversationId = cleanId(response?.conversationId) || execution.conversationId;
      const updates = {
        executionHeartbeatAt: timestamp,
        executionState: state,
        ...(conversationId ? {conversationId, executionConversationId: conversationId} : {}),
        updatedAt: timestamp,
      };
      transaction.update(refs.runRef, updates);
      transaction.update(refs.sessionRef, {
        automationExecutionHeartbeatAt: timestamp,
        automationExecutionState: state,
        ...(conversationId ? {automationConversationId: conversationId} : {}),
        updatedAt: timestamp,
      });
      return true;
    });
  }

  async function writeOutcome(status, errorCode, response, {allowStaleClaim = false} = {}) {
    if (!execution || execution.terminal) return false;
    clearPollTimer();
    const refs = assignmentRefs();
    const timestamp = serverTimestamp();
    const written = await db.runTransaction(async (transaction) => {
      const [sessionSnap, runSnap] = await Promise.all([
        transaction.get(refs.sessionRef),
        transaction.get(refs.runRef),
      ]);
      if (!sameExecutionIdentity(sessionSnap, runSnap, {allowStaleClaim})) return false;
      const run = runSnap.data() || {};
      const currentStatus = String(run.status || "").trim().toLowerCase();
      if (AUTOMATION_TERMINAL_STATUSES.has(currentStatus)) return false;
      const cancellationCommitted = run.desiredOutcome === "canceled" ||
        (currentStatus === "stopping" && run.cancellationRequestedAt);
      const interruptionCommitted = currentStatus === "stopping" && run.desiredOutcome === "interrupted";
      const effectiveStatus = cancellationCommitted ? "canceled" : interruptionCommitted ? "interrupted" : status;
      const outcomeError = interruptionCommitted && !cancellationCommitted ? run.interruptionReason || "automation_interrupted" : errorCode;
      const normalizedError = outcomeError ? normalizeFailureCode(outcomeError, "automation_execution_failed") : null;
      const conversationId = cleanId(response?.conversationId) || execution.conversationId;
      const rawFinalResult = cleanId(response?.state?.finalResult || response?.finalResult).toLowerCase();
      const finalResult = ["success", "error"].includes(rawFinalResult) ? rawFinalResult : "";
      const finalAnswer = effectiveStatus === "succeeded" && finalResult === "success" ?
        normalizeFinalAnswer(response?.state?.finalAnswer) : null;
      const runUpdates = {
        cleanupState: "pending",
        desiredOutcome: effectiveStatus,
        endedAt: timestamp,
        executionEndedAt: timestamp,
        executionHeartbeatAt: timestamp,
        executionOutcome: effectiveStatus,
        executionState: effectiveStatus,
        ...(conversationId ? {conversationId, executionConversationId: conversationId} : {}),
        ...(finalResult ? {finalResult} : {}),
        ...(finalAnswer ? {finalAnswer} : {}),
        ...(normalizedError ? {executionErrorCode: normalizedError, lastError: normalizedError} : {}),
        status: effectiveStatus,
        updatedAt: timestamp,
      };
      transaction.update(refs.runRef, runUpdates);
      transaction.update(refs.sessionRef, {
        automationExecutionEndedAt: timestamp,
        automationExecutionHeartbeatAt: timestamp,
        automationExecutionOutcome: effectiveStatus,
        automationExecutionState: effectiveStatus,
        ...(conversationId ? {automationConversationId: conversationId} : {}),
        ...(normalizedError ? {automationExecutionErrorCode: normalizedError} : {}),
        updatedAt: timestamp,
      });
      return true;
    });
    if (written) execution.terminal = status;
    return written;
  }

  async function finish(status, errorCode, response) {
    await writeOutcome(status, errorCode, response);
  }

  function schedulePoll() {
    if (stopped || !execution || execution.terminal || pollTimer !== null) return;
    pollTimer = setTimeoutImpl(() => {
      pollTimer = null;
      void pollOnce();
    }, pollIntervalMs);
    pollTimer?.unref?.();
  }

  function clearPollTimer() {
    if (pollTimer === null) return;
    clearTimeoutImpl(pollTimer);
    pollTimer = null;
  }

  function assignmentRefs() {
    const current = currentAssignment();
    if (!db || typeof db.collection !== "function" || !config.workspaceId || !current.sessionId || !current.runId) {
      throw automationError("automation_assignment_unavailable");
    }
    const workspaceRef = (current.native ? db.collection("vmRuntimes_v2") : db.collection("workspaces"))
        .doc(config.workspaceId);
    return {
      runRef: db.collection("automationRuns").doc(current.runId),
      sessionRef: workspaceRef.collection("sessions").doc(current.sessionId),
      workspaceRef,
    };
  }

  function currentAuthority() {
    const authority = workspaceAuthority?.status?.() || {};
    if (workspaceAuthority && typeof workspaceAuthority.isCurrentWriter === "function" && !workspaceAuthority.isCurrentWriter()) {
      throw automationError("automation_assignment_authority_lost");
    }
    if (authority.admitted === false) throw automationError("automation_assignment_not_admitted");
    const generation = positiveGeneration(authority.generation || config.agentRuntimeGeneration);
    const bootInstanceId = cleanId(authority.bootInstanceId);
    if (!bootInstanceId || !generation) throw automationError("automation_assignment_authority_invalid");
    return {bootInstanceId, generation};
  }

  function assertAuthority() {
    currentAuthority();
  }

  function sameExecutionIdentity(sessionSnap, runSnap, {allowStaleClaim = false} = {}) {
    if (!sessionSnap?.exists || !runSnap?.exists) return false;
    const session = sessionSnap.data() || {};
    const run = runSnap.data() || {};
    const authority = currentAuthority();
    const executionBootMatches = String(run.executionBootInstanceId || "") === authority.bootInstanceId &&
      positiveGeneration(run.executionGeneration) === authority.generation;
    const current = currentAssignment();
    if (current.native) {
      return (run.runId || current.runId) === current.runId &&
        run.sessionId === current.sessionId &&
        run.workspaceId === config.workspaceId &&
        (executionBootMatches || (allowStaleClaim && Boolean(run.executionStartedAt))) &&
        session.ownerUid === run.ownerUid &&
        session.generation === authority.generation &&
        session.state === "active" &&
        run.executionRoute === "vm-native-v1";
    }
    return (run.runId || current.runId) === current.runId &&
      run.sessionId === current.sessionId &&
      run.workspaceId === config.workspaceId &&
      (executionBootMatches || (allowStaleClaim && Boolean(run.executionStartedAt))) &&
      String(session.runtimeKind || "").trim().toLowerCase() === "automation" &&
      String(session.automationRunId || "") === config.automationRunId &&
      String(session.agentRuntimeBootInstanceId || "") === authority.bootInstanceId &&
      positiveGeneration(session.agentRuntimeGeneration) === authority.generation &&
      String(session.agentRuntimeAuthorityState || "").trim().toLowerCase() === "admitted";
  }

  function bounded(value, timeoutMs, code) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeoutImpl(() => {
        const error = automationError(code);
        reject(error);
      }, Math.max(1, timeoutMs));
      timer?.unref?.();
    });
    return Promise.race([value, timeout]).finally(() => {
      if (timer !== undefined) clearTimeoutImpl(timer);
    });
  }

  function status() {
    return {
      enabled,
      pollScheduled: pollTimer !== null,
      runId: execution?.runId || currentAssignment()?.runId || null,
      state: execution?.terminal || (execution?.submitted ? "running" : execution ? "claimed" : "idle"),
      submitted: Boolean(execution?.submitted),
      terminal: execution?.terminal || null,
    };
  }

  async function statusFor(runId) {
    const normalizedRunId = cleanId(runId);
    if (execution?.runId === normalizedRunId) {
      const current = status();
      return {ok: true, ...current, status: current.terminal || (current.submitted ? "running" : "submitted")};
    }
    if (!native || !normalizedRunId || !db) return {ok: false, error: "automation_run_not_found"};
    const runSnap = await db.collection("automationRuns").doc(normalizedRunId).get();
    if (!runSnap.exists || runSnap.data()?.sessionId !== config.sessionId ||
        runSnap.data()?.workspaceId !== config.workspaceId || runSnap.data()?.executionRoute !== "vm-native-v1") {
      return {ok: false, error: "automation_run_not_found"};
    }
    const run = runSnap.data() || {};
    const status = cleanId(run.status).toLowerCase() || (run.executionStartedAt ? "running" : "submitted");
    const terminal = AUTOMATION_TERMINAL_STATUSES.has(status) ? status : null;
    return {ok: true, runId: normalizedRunId, status, state: terminal ? {terminal, finalResult: run.finalResult || null, finalAnswer: run.finalAnswer || null} : {}};
  }

  function currentAssignment() {
    return assignment || (config.automationRunId ? {native: false, runId: config.automationRunId, sessionId: config.sessionId} : null);
  }

  async function disposeNativeRuntime() {
    if (!execution?.runtime) return;
    const runtime = execution.runtime;
    execution.runtime = null;
    await Promise.resolve(runtime.cleanup?.()).catch((error) => logger.warn?.("VM automation runtime cleanup failed", safeError(error)));
  }

  function serverTimestamp() {
    return admin?.firestore?.FieldValue?.serverTimestamp?.() || new Date(now()).toISOString();
  }

  function validateAssignment({authority, workspaceSnap, sessionSnap, runSnap, refs}) {
    if (!workspaceSnap?.exists || !sessionSnap?.exists || !runSnap?.exists) {
      throw automationError("automation_assignment_missing");
    }
    const workspace = workspaceSnap.data() || {};
    const session = sessionSnap.data() || {};
    const run = {runId: runSnap.id || config.automationRunId, ...runSnap.data()};
    if (workspace.deleted === true || ["deleting", "deleted"].includes(
        String(workspace.lifecycle || workspace.status || "").trim().toLowerCase(),
    )) {
      throw automationError("automation_workspace_deleted");
    }
    const runStatus = String(run.status || "").trim().toLowerCase();
    const current = currentAssignment();
    if (run.runId !== current.runId || run.workspaceId !== config.workspaceId || run.sessionId !== refs.sessionRef.id ||
        (!current.native && session.workspaceId !== config.workspaceId) || session.ownerUid !== run.ownerUid || run.ownerUid !== config.ownerUid ||
        workspace.ownerUid !== run.ownerUid) {
      throw automationError("automation_assignment_identity_mismatch");
    }
    if (current.native) {
      if (workspace.backend !== "compute-engine" || workspace.currentSessionId !== refs.sessionRef.id ||
          workspace.generation !== authority.generation || session.generation !== authority.generation ||
          session.state !== "active" || run.executionRoute !== "vm-native-v1") {
        throw automationError("automation_assignment_session_not_admitted");
      }
      const prompt = typeof run.snapshot?.prompt === "string" ? run.snapshot.prompt : "";
      if (!prompt.trim()) throw automationError("automation_assignment_prompt_missing");
      return {
        bootInstanceId: authority.bootInstanceId,
        generation: authority.generation,
        modelRef: modelReference(run.snapshot?.modelSelection),
        native: true,
        prompt,
        runId: run.runId,
        runStatus,
        desiredOutcome: run.desiredOutcome || null,
        executionStartedAt: run.executionStartedAt || null,
      };
    }
    if (String(session.runtimeKind || "").trim().toLowerCase() !== "automation" ||
        String(session.automationRunId || "").trim() !== run.runId ||
        String(session.runnerSessionId || refs.sessionRef.id) !== refs.sessionRef.id ||
        String(session.agentRuntimeSessionId || "").trim() !== refs.sessionRef.id ||
        String(session.agentRuntimeAuthorityState || "").trim().toLowerCase() !== "admitted" ||
        String(session.agentRuntimeBootInstanceId || "").trim() !== authority.bootInstanceId ||
        positiveGeneration(session.agentRuntimeGeneration) !== authority.generation ||
        !AUTOMATION_ACTIVE_SESSION_STATUSES.has(String(session.status || "").trim().toLowerCase())) {
      throw automationError("automation_assignment_session_not_admitted");
    }
    const prompt = typeof run.snapshot?.prompt === "string" ? run.snapshot.prompt : "";
    if (!prompt.trim()) throw automationError("automation_assignment_prompt_missing");
    return {
      bootInstanceId: authority.bootInstanceId,
      generation: authority.generation,
      modelRef: modelReference(run.snapshot?.modelSelection),
      native: false,
      prompt,
      runId: run.runId,
      runStatus,
      desiredOutcome: run.desiredOutcome || null,
      executionStartedAt: run.executionStartedAt || null,
    };
  }
}

function nativeAutomationPrompt(prompt) {
  return "The live workspace is not your working directory. Read input files only from " +
    "/workspace-input, which is a read-only snapshot. Write every result and generated file " +
    "under /workspace. Do not attempt to modify or access the live workspace mount.\n\n" + prompt;
}

function normalizeOutcome(response = {}) {
  const state = response.state && typeof response.state === "object" ? response.state : {};
  const terminal = cleanId(state.terminal).toLowerCase();
  const status = cleanId(response.status).toLowerCase();
  if (terminal === "interaction_required" || status === "interaction_required") {
    return {errorCode: "automation_interaction_required", response, status: "failed"};
  }
  if (terminal === "failed" || status === "failed") {
    return {
      errorCode: classifyAutomationFailure(state.finalError),
      response,
      status: "failed",
    };
  }
  if (terminal === "canceled" || status === "canceled") {
    return {errorCode: "automation_canceled", response, status: "canceled"};
  }
  if (terminal === "succeeded") return {errorCode: null, response, status: "succeeded"};
  if (status === "succeeded" && (!terminal || terminal === "succeeded") && state.finalResult !== "error") {
    return {errorCode: null, response, status: "succeeded"};
  }
  return null;
}

function modelReference(selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return "";
  const providerId = cleanId(selection.providerId);
  const modelId = cleanId(selection.modelId);
  return providerId && modelId ? `${providerId}/${modelId}` : "";
}

function normalizeFinalAnswer(value) {
  if (typeof value !== "string") return null;
  const answer = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return answer ? answer.slice(0, MAX_AUTOMATION_FINAL_ANSWER_LENGTH) : null;
}

function positiveGeneration(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanId(value) {
  return String(value || "").trim();
}

function normalizeFailureCode(value, fallback) {
  const candidate = cleanId(value).toLowerCase();
  const wrappedStartFailure = /^automation_start_failed:([a-z][a-z0-9_]{2,127})$/.exec(candidate);
  if (wrappedStartFailure) return wrappedStartFailure[1];
  return /^[a-z][a-z0-9_]{2,127}$/.test(candidate) ? candidate : fallback;
}

function classifyAutomationFailure(value) {
  const message = cleanId(value).toLowerCase();
  if (!message) return "automation_agent_failed";
  const explicitCode = normalizeFailureCode(message, "");
  if (explicitCode && explicitCode.startsWith("automation_")) return explicitCode;
  if (/^(?:automation_)?(?:model_unavailable|model_not_found|unknown_model|provider_model_unavailable)$/.test(message)) {
    return "automation_model_unavailable";
  }
  if (/\b(401|unauthori[sz]ed|unauthenticated|invalid[_ -]?grant|api[_ -]?key|credential|authentication)\b/.test(message)) {
    return "automation_provider_auth_failed";
  }
  if (/\b(429|rate[_ -]?limit|too many requests|quota|resource exhausted)\b/.test(message)) {
    return "automation_provider_rate_limited";
  }
  if (/\b(model|provider)\b.{0,48}\b(unavailable|not found|unknown|does not exist|unsupported)\b|\bunknown model\b/.test(message)) {
    return "automation_model_unavailable";
  }
  if (/\b(timeout|timed out|econn|enotfound|network|socket|fetch failed|connection refused)\b/.test(message)) {
    return "automation_provider_network_failed";
  }
  if (/\b(400|bad request|invalid request|request rejected|unsupported request)\b/.test(message)) {
    return "automation_provider_request_rejected";
  }
  return "automation_agent_failed";
}

function automationError(code) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  return error;
}

function safeError(error) {
  return {code: normalizeFailureCode(error?.code, "automation_execution_failed")};
}

module.exports = {
  AUTOMATION_ACTIVE_RUN_STATUSES,
  AUTOMATION_ACTIVE_SESSION_STATUSES,
  createAutomationExecutionService,
  modelReference,
  normalizeOutcome,
};
