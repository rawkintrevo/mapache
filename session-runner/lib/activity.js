"use strict";

const {compactErrorMessage} = require("./utils");

const LIVE_RUNTIME_STATUSES = new Set(["running", "restarting", "resizing"]);

function createActivityService({admin, db, config}) {
  const {workspaceId, sessionId} = config;

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
    await sessionRef()
        .update(updates)
        .catch((error) => console.error("session activity write failed", error));
  }

  async function markRuntimeStartupFailure(error) {
    if (!workspaceId || !sessionId) return;
    const runtimeError = compactErrorMessage(error && error.message ? error.message : error);
    const ref = sessionRef();
    try {
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) return;
        const session = snap.data() || {};
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
    updatePiSessionBinding,
    updateSessionActivity,
    updateWorkspaceSourceState,
  };
}

module.exports = {
  createActivityService,
};
