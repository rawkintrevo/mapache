"use strict";

const {compactErrorMessage} = require("./utils");

const LIVE_RUNTIME_STATUSES = new Set(["running", "restarting", "resizing"]);
const ADMISSION_SESSION_STATUSES = new Set([
  "provisioning",
  "running",
  "restarting",
  "resizing",
  "stopping",
  "deleting",
]);

function createActivityService({admin, db, config, getRuntimeIdentity, isCurrentRuntime, logger = console}) {
  const {workspaceId, sessionId} = config;
  let activityTimer = null;
  let pendingActivity = false;

  function sessionRef() {
    return db.collection("workspaces")
        .doc(workspaceId)
        .collection("sessions")
        .doc(sessionId);
  }

  async function appendHistory(stream, data) {
    if (!workspaceId || !sessionId) return;
    const body = String(data || "");
    if (!body) return;
    await db.collection("workspaces")
        .doc(workspaceId)
        .collection("sessions")
        .doc(sessionId)
        .collection("terminalHistory")
        .add({
          stream,
          data: body.slice(0, 4096),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })
        .catch((error) => console.error("terminal history write failed", error));
  }

  async function updateSessionActivity(updates) {
    if (!workspaceId || !sessionId) return;
    if (typeof isCurrentRuntime === "function" && !isCurrentRuntime()) return;
    await sessionRef()
        .update(updates)
        .catch((error) => console.error("session activity write failed", error));
  }

  function markMeaningfulActivity() {
    if (activityTimer) clearTimeout(activityTimer);
    pendingActivity = true;
    activityTimer = setTimeout(() => {
      activityTimer = null;
      if (!pendingActivity) return;
      pendingActivity = false;
      void updateSessionActivity({lastActivityAt: admin.firestore.FieldValue.serverTimestamp()});
    }, config.activityWriteDebounceMs);
    activityTimer.unref?.();
  }

  async function markRuntimeStartupFailure(error, {allowUnadmitted = false} = {}) {
    if (!workspaceId || !sessionId) return;
    const runtimeError = compactErrorMessage(error && error.message ? error.message : error);
    const ref = sessionRef();
    const workspaceRef = db.collection("workspaces").doc(workspaceId);
    const identity = typeof getRuntimeIdentity === "function" ? getRuntimeIdentity() : null;
    const enforceOwnership = Boolean(identity?.enabled && identity.bootInstanceId);
    try {
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) return;
        const session = snap.data() || {};
        let workspace = null;
        if (enforceOwnership && String(config.runtimeKind || "").trim().toLowerCase() !== "automation") {
          const workspaceSnap = await transaction.get(workspaceRef);
          if (!workspaceSnap?.exists) {
            logSkippedStartupFailure(identity, "workspace_missing");
            return;
          }
          workspace = workspaceSnap.data() || {};
        }
        if (enforceOwnership) {
          const reason = startupFailureEligibility({
            allowUnadmitted,
            config,
            identity,
            session,
            workspace,
          });
          if (reason) {
            logSkippedStartupFailure(identity, reason);
            return;
          }
        }
        const failedAt = admin.firestore.FieldValue.serverTimestamp();
        const updates = {
          activeSocketCount: 0,
          lastError: session.lastError || runtimeError || "runner_startup_failed",
          runtimeFailedAt: failedAt,
          runtimeLastError: runtimeError || "runner_startup_failed",
          runtimeState: "failed",
          updatedAt: failedAt,
        };
        if (LIVE_RUNTIME_STATUSES.has(String(session.status || "").trim())) {
          updates.status = "update_failed";
        }
        transaction.update(ref, updates);
      });
    } catch (writeError) {
      console.error("session runtime failure write failed", writeError);
    }
  }

  function logSkippedStartupFailure(identity, reason) {
    logger.warn?.("session startup failure skipped after runtime ownership check", {
      workspaceId,
      sessionId,
      bootInstanceId: identity?.bootInstanceId || null,
      generation: identity?.generation || config.agentRuntimeGeneration || null,
      reason,
    });
  }

  async function updateWorkspaceSourceState(updates) {
    if (!workspaceId) return;
    const workspaceUpdates = Object.entries(updates || {}).reduce((acc, [key, value]) => {
      acc[`source.${key}`] = value;
      return acc;
    }, {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection("workspaces")
        .doc(workspaceId)
        .update(workspaceUpdates)
        .catch((error) => console.error("workspace source update failed", error));
  }

  async function updatePiSessionBinding(updates) {
    if (!workspaceId || !sessionId) return;
    await db.collection("workspaces")
        .doc(workspaceId)
        .collection("sessions")
        .doc(sessionId)
        .update({
          ...updates,
          piSessionBoundAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        })
        .catch((error) => console.error("pi session binding update failed", error));
  }

  return {
    appendHistory,
    markRuntimeStartupFailure,
    markMeaningfulActivity,
    updatePiSessionBinding,
    updateSessionActivity,
    updateWorkspaceSourceState,
  };
}

function startupFailureEligibility({allowUnadmitted, config, identity, session, workspace}) {
  const generation = positiveGeneration(identity.generation || config.agentRuntimeGeneration);
  if (!generation || positiveGeneration(session.agentRuntimeGeneration) !== generation) {
    return "generation_mismatch";
  }
  if (!ADMISSION_SESSION_STATUSES.has(String(session.status || "").trim().toLowerCase())) {
    return "session_state_not_admissible";
  }

  const automationRuntime = String(config.runtimeKind || "").trim().toLowerCase() === "automation";
  if (automationRuntime) {
    if (String(session.runtimeKind || "").trim().toLowerCase() !== "automation" ||
        String(session.agentRuntimeSessionId || "").trim() !== String(config.sessionId || "").trim() ||
        (config.automationRunId && String(session.automationRunId || "").trim() !== String(config.automationRunId).trim())) {
      return "session_identity_mismatch";
    }
    const sessionBoot = String(session.agentRuntimeBootInstanceId || "").trim();
    if (sessionBoot) {
      return sessionBoot === String(identity.bootInstanceId).trim() &&
        String(session.agentRuntimeAuthorityState || "").trim().toLowerCase() === "admitted" &&
        identity.admitted === true ? null : "boot_ownership_mismatch";
    }
    return allowUnadmitted && identity.admitted !== true ? null : "boot_not_admitted";
  }

  if (!workspace || positiveGeneration(workspace.agentRuntimeGeneration) !== generation ||
      String(workspace.agentRuntimeSessionId || "").trim() !== String(config.sessionId || "").trim()) {
    return "workspace_identity_mismatch";
  }
  const workspaceBoot = String(workspace.agentRuntimeBootInstanceId || "").trim();
  const sessionBoot = String(session.agentRuntimeBootInstanceId || "").trim();
  if (workspaceBoot || sessionBoot) {
    return workspaceBoot === String(identity.bootInstanceId).trim() &&
      sessionBoot === String(identity.bootInstanceId).trim() &&
      String(workspace.agentRuntimeAuthorityState || "").trim().toLowerCase() === "admitted" &&
      String(session.agentRuntimeAuthorityState || "").trim().toLowerCase() === "admitted" &&
      identity.admitted === true ? null : "boot_ownership_mismatch";
  }
  if (String(workspace.agentRuntimeAuthorityState || "").trim().toLowerCase() === "admitted" ||
      String(session.agentRuntimeAuthorityState || "").trim().toLowerCase() === "admitted") {
    return "authority_state_without_boot";
  }
  return allowUnadmitted && identity.admitted !== true ? null : "boot_not_admitted";
}

function positiveGeneration(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

module.exports = {
  createActivityService,
};
