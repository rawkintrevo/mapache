"use strict";

const crypto = require("node:crypto");
const logger = require("firebase-functions/logger");

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {automationSessionId, isAutomationRuntime} = require("./runtimePaths.helpers");
const {automationCloudRunServiceId} = require("./provisioning.helpers");
const {isSupportedProvisioningSession} = require("./runnerCatalog.helpers");
const {isTerminalAutomationStatus, transitionAutomationRun} = require("./automationState.helpers");
const {selectAutomationChromeProfileSeed} = require("./chromeProfileSeed.service");

const AUTOMATION_PROVISIONING_TIMEOUT_MS = 15 * 60 * 1000;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

function createAutomationProvisioningService(dependencies = {}) {
  const shared = {
    admin: dependencies.admin || defaultAdmin,
    createSession: dependencies.createSession,
    db: dependencies.db || defaultDb,
    featureEnabled: dependencies.featureEnabled,
    provisionSessionService: dependencies.provisionSessionService,
    requireWorkspace: dependencies.requireWorkspace,
    sessionCollection: dependencies.sessionCollection,
    requestRunnerJson: dependencies.requestRunnerJson,
    storage: dependencies.storage,
  };
  if (typeof shared.createSession !== "function") {
    throw new Error("Automation provisioning requires a createSession dependency.");
  }
  if (typeof shared.provisionSessionService !== "function") {
    throw new Error("Automation provisioning requires a provisionSessionService dependency.");
  }
  if (typeof shared.requireWorkspace !== "function") {
    throw new Error("Automation provisioning requires a requireWorkspace dependency.");
  }
  if (typeof shared.sessionCollection !== "function") {
    throw new Error("Automation provisioning requires a sessionCollection dependency.");
  }
  return {
    handleAutomationRunEvent: (event) => handleAutomationRunEvent(event, shared),
    handleAutomationSessionEvent: (event) => handleAutomationSessionEvent(event, shared),
    provisionAutomationRun: (runId) => provisionAutomationRun(runId, shared),
  };
}

async function handleAutomationRunEvent(event, dependencies = {}) {
  const after = event && event.data && event.data.after;
  if (!after || !after.exists) return {skipped: "deleted"};
  const before = event.data.before;
  const run = after.data() || {};
  // Claim/attachment/heartbeat writes must not recursively provision the run.
  // The minute reconciler resumes incomplete work after a worker is lost.
  if (run.status !== "provisioning" || before?.exists && before.data()?.status === "provisioning") {
    return {skipped: "not_admission", runId: after.id || event.params?.runId};
  }
  return provisionAutomationRun(after.id || event.params?.runId, dependencies);
}

async function handleAutomationSessionEvent(event, dependencies = {}) {
  const after = event && event.data && event.data.after;
  if (!after || !after.exists) return {skipped: "deleted"};
  const session = {id: after.id, ...after.data()};
  if (!isAutomationRuntime(session)) return {skipped: "not_automation"};
  const before = event.data.before;
  if (!["running", "provision_failed"].includes(session.status) ||
      before?.exists && before.data()?.status === session.status) {
    return {skipped: "not_provisioning_result"};
  }
  const runId = session.automationRunId || event.params?.sessionId?.replace(/^auto-/, "");
  if (!runId) return {skipped: "missing_run_id"};
  return provisionAutomationRun(runId, dependencies);
}

async function provisionAutomationRun(runId, dependencies = {}) {
  const normalizedRunId = normalizeRunId(runId);
  if (typeof dependencies.featureEnabled === "function" && !(await dependencies.featureEnabled())) {
    return {skipped: "disabled", runId: normalizedRunId};
  }

  const runRef = dependencies.db.collection("automationRuns").doc(normalizedRunId);
  const claim = await claimAutomationRun(runRef, normalizedRunId, dependencies);
  if (claim.action !== "provision") return {skipped: claim.reason, runId: normalizedRunId};

  const run = claim.run;
  let sessionRef;
  try {
    const workspace = await dependencies.requireWorkspace(run.ownerUid, run.workspaceId);
    const chromeProfileSeed = await selectAutomationChromeProfileSeed({
      requestRunnerJson: dependencies.requestRunnerJson,
      run,
      sessionCollection: dependencies.sessionCollection,
      storage: dependencies.storage,
      workspace: {...workspace, id: workspace.id || run.workspaceId},
    });
    const pinnedRun = {
      ...run,
      chromeProfileInitialization: {
        mode: chromeProfileSeed.mode,
        reason: chromeProfileSeed.reason,
        capturedAt: chromeProfileSeed.descriptor?.capturedAt || null,
        ageMs: chromeProfileSeed.ageMs,
      },
      ...(chromeProfileSeed.descriptor ? {chromeProfileSeed: chromeProfileSeed.descriptor} : {}),
    };
    const session = await ensureAutomationSession(pinnedRun, workspace, dependencies, chromeProfileSeed);
    sessionRef = dependencies.sessionCollection(run.workspaceId).doc(session.id);
    const attached = await attachSessionToRun(runRef, pinnedRun, session, dependencies);
    if (!attached) return {skipped: "run_stopping", runId: normalizedRunId, sessionId: session.id};

    const currentSessionSnap = await sessionRef.get();
    const currentSession = currentSessionSnap.exists ?
      {id: currentSessionSnap.id, ...currentSessionSnap.data()} : session;
    if (currentSession.status === "running" && currentSession.serviceUrl) {
      await markAutomationRunRunning(runRef, currentSession, dependencies);
      return {provisioned: true, runId: normalizedRunId, sessionId: currentSession.id};
    }
    if (currentSession.status === "provision_failed") {
      await markAutomationRunFailure(runRef, currentSession.lastError, currentSession, dependencies);
      return {provisioned: false, runId: normalizedRunId, sessionId: currentSession.id};
    }

    await dependencies.provisionSessionService(workspace, sessionRef, currentSession);
    const afterProvisionSnap = await sessionRef.get();
    const afterProvision = afterProvisionSnap.exists ?
      {id: afterProvisionSnap.id, ...afterProvisionSnap.data()} : currentSession;
    if (afterProvision.status === "running" && afterProvision.serviceUrl) {
      await markAutomationRunRunning(runRef, afterProvision, dependencies);
      return {provisioned: true, runId: normalizedRunId, sessionId: afterProvision.id};
    }
    if (afterProvision.status === "provision_failed") {
      await markAutomationRunFailure(runRef, afterProvision.lastError, afterProvision, dependencies);
      return {provisioned: false, runId: normalizedRunId, sessionId: afterProvision.id};
    }
    return {provisioning: true, runId: normalizedRunId, sessionId: afterProvision.id};
  } catch (error) {
    const failureCode = stableAutomationFailureCode(error);
    await markAutomationRunFailure(runRef, failureCode, sessionRef ? {id: sessionRef.id} : null, dependencies);
    logger.warn("automation provisioning failed", {
      runId: normalizedRunId,
      workspaceId: run.workspaceId,
      code: failureCode,
    });
    return {provisioned: false, runId: normalizedRunId, error: failureCode};
  }
}

async function claimAutomationRun(runRef, runId, dependencies = {}) {
  const firestoreAdmin = dependencies.admin || defaultAdmin;
  return dependencies.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(runRef);
    if (!snapshot.exists) return {action: "skip", reason: "run_not_found"};
    const run = {runId, ...snapshot.data()};
    const workspaceRef = dependencies.db.collection("workspaces").doc(run.workspaceId);
    const workspaceSnap = await transaction.get(workspaceRef);
    const workspace = workspaceSnap.exists ? workspaceSnap.data() || {} : {};
    if (!workspaceSnap.exists || workspace.deleted === true || ["deleting", "deleted"].includes(
        String(workspace.lifecycle || workspace.status || "").trim().toLowerCase(),
    )) {
      return {action: "skip", reason: "workspace_unavailable"};
    }
    if (String(run.status || "").trim().toLowerCase() !== "provisioning") {
      return {action: "skip", reason: `status_${String(run.status || "unknown").trim().toLowerCase()}`};
    }

    const operationId = run.provisioningOperationId || automationProvisioningOperationId(run.workspaceId, runId);
    const serviceId = run.provisioningServiceId || automationCloudRunServiceId(runId);
    if (run.provisioningOperationId && run.provisioningServiceId && run.provisioningClaim) {
      return {action: "provision", run};
    }
    const now = firestoreAdmin.firestore.FieldValue.serverTimestamp();
    const claim = {
      ...(run.provisioningClaim || {}),
      operationId,
      serviceId,
      state: "claimed",
      claimedAt: run.provisioningClaim?.claimedAt || now,
      updatedAt: now,
    };
    transaction.update(runRef, {
      provisioningClaim: claim,
      provisioningOperationId: operationId,
      provisioningServiceId: serviceId,
      provisioningState: "claimed",
      provisioningStartedAt: run.provisioningStartedAt || now,
      updatedAt: now,
    });
    return {
      action: "provision",
      run: {
        ...run,
        provisioningClaim: claim,
        provisioningOperationId: operationId,
        provisioningServiceId: serviceId,
      },
    };
  });
}

async function ensureAutomationSession(run, workspace, dependencies = {}, chromeProfileSeed = null) {
  const sessionId = automationSessionId(run.runId);
  const sessionRef = dependencies.sessionCollection(run.workspaceId).doc(sessionId);
  const existingSnap = await sessionRef.get();
  if (!existingSnap.exists) {
    await dependencies.createSession(run.ownerUid, run.workspaceId, {
      imageKey: "pi-chrome",
      name: run.snapshot?.name || "Automation run",
      operationId: run.provisioningOperationId,
      resources: run.snapshot?.resources || workspace.resources || undefined,
      automationRunAt: run.createdAt,
      automationTimezone: run.snapshot?.timezone,
      runtimeKind: "automation",
      runId: run.runId,
      sessionType: "cloud",
      chromeProfileSeed: chromeProfileSeed?.descriptor || run.chromeProfileSeed || null,
      chromeProfileInitialization: run.chromeProfileInitialization || {
        mode: chromeProfileSeed?.mode || "fresh",
        reason: chromeProfileSeed?.reason || "no_seed",
        capturedAt: chromeProfileSeed?.descriptor?.capturedAt || null,
        ageMs: chromeProfileSeed?.ageMs ?? null,
      },
    });
  }

  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw automationError("automation_session_missing");
  const session = {id: sessionSnap.id, ...sessionSnap.data()};
  assertAutomationSessionIdentity(session, run);
  return session;
}

async function attachSessionToRun(runRef, run, session, dependencies = {}) {
  const now = (dependencies.admin || defaultAdmin).firestore.FieldValue.serverTimestamp();
  return dependencies.db.runTransaction(async (transaction) => {
    const currentSnap = await transaction.get(runRef);
    if (!currentSnap.exists) return false;
    const current = currentSnap.data() || {};
    if (isTerminalAutomationStatus(current.status) || current.status === "stopping" || current.desiredOutcome === "canceled") return false;
    if (current.sessionId === session.id && current.provisioningState === "provisioning") return true;
    transaction.update(runRef, {
      sessionId: session.id,
      ...(run.chromeProfileInitialization ? {chromeProfileInitialization: run.chromeProfileInitialization} : {}),
      ...(run.chromeProfileSeed ? {chromeProfileSeed: run.chromeProfileSeed} : {}),
      ...(session.automationStorage ? {workspaceOutput: session.automationStorage.output} : {}),
      provisioningState: "provisioning",
      provisioningClaim: {
        ...(current.provisioningClaim || run.provisioningClaim || {}),
        sessionId: session.id,
        state: "provisioning",
        updatedAt: now,
      },
      updatedAt: now,
    });
    return true;
  });
}

async function markAutomationRunRunning(runRef, session, dependencies = {}) {
  const now = (dependencies.admin || defaultAdmin).firestore.FieldValue.serverTimestamp();
  await dependencies.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(runRef);
    if (!snapshot.exists) return;
    const current = snapshot.data() || {};
    if (current.status !== "provisioning") return;
    const next = transitionAutomationRun(current, "running", {
      sessionId: session.id,
      startedAt: current.startedAt || now,
      provisioningState: "ready",
      provisioningClaim: {
        ...(current.provisioningClaim || {}),
        sessionId: session.id,
        state: "complete",
        completedAt: now,
      },
      updatedAt: now,
    });
    transaction.update(runRef, next);
  });
}

async function markAutomationRunFailure(runRef, error, session, dependencies = {}) {
  const failureCode = stableAutomationFailureCode(error);
  const now = (dependencies.admin || defaultAdmin).firestore.FieldValue.serverTimestamp();
  await dependencies.db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(runRef);
    if (!snapshot.exists) return;
    const current = snapshot.data() || {};
    if (isTerminalAutomationStatus(current.status)) return;
    if (!["provisioning", "running"].includes(current.status)) return;
    const next = transitionAutomationRun(current, "failed", {
      cleanupState: "pending",
      desiredOutcome: "failed",
      endedAt: now,
      lastError: failureCode,
      provisioningErrorCode: failureCode,
      provisioningState: "failed",
      provisioningClaim: {
        ...(current.provisioningClaim || {}),
        ...(session?.id ? {sessionId: session.id} : {}),
        state: "failed",
        failureCode,
        failedAt: now,
      },
      ...(session?.id ? {sessionId: session.id} : {}),
      updatedAt: now,
    });
    transaction.update(runRef, next);
  });
}

function assertAutomationSessionIdentity(session, run) {
  if (!isAutomationRuntime(session) || session.automationRunId !== run.runId ||
      session.workspaceId !== run.workspaceId || session.ownerUid !== run.ownerUid ||
      session.serviceId !== automationCloudRunServiceId(run.runId) ||
      session.serviceName && !session.serviceName.endsWith(`/services/${automationCloudRunServiceId(run.runId)}`) ||
      !isSupportedProvisioningSession(session)) {
    throw automationError("automation_session_identity_mismatch");
  }
}


function stableAutomationFailureCode(error) {
  const candidate = String(typeof error === "string" ? error : error?.publicMessage || error?.code || error?.message || "").trim();
  if (/^[a-z][a-z0-9_]{2,127}$/.test(candidate)) return candidate;
  if (/quota|resource exhausted/i.test(candidate)) return "cloud_run_quota_exceeded";
  if (/permission|unauthenticated|forbidden/i.test(candidate)) return "cloud_run_permission_denied";
  return "automation_provisioning_failed";
}

function automationProvisioningOperationId(workspaceId, runId) {
  return `automation-${crypto.createHash("sha256").update(`${workspaceId}/${runId}`).digest("hex").slice(0, 48)}`;
}

function normalizeRunId(value) {
  const runId = String(value || "").trim();
  if (!RUN_ID_PATTERN.test(runId)) throw automationError("invalid_automation_run_id");
  return runId;
}

function automationError(code) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  return error;
}

module.exports = {
  AUTOMATION_PROVISIONING_TIMEOUT_MS,
  assertAutomationSessionIdentity,
  automationProvisioningOperationId,
  createAutomationProvisioningService,
  handleAutomationRunEvent,
  handleAutomationSessionEvent,
  markAutomationRunFailure,
  markAutomationRunRunning,
  normalizeRunId,
  provisionAutomationRun,
  stableAutomationFailureCode,
};
