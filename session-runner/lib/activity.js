"use strict";

function createActivityService({admin, db, config}) {
  const {workspaceId, sessionId} = config;

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
    await db.collection("workspaces")
        .doc(workspaceId)
        .collection("sessions")
        .doc(sessionId)
        .update(updates)
        .catch((error) => console.error("session activity write failed", error));
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

  return {
    appendHistory,
    updateSessionActivity,
    updateWorkspaceSourceState,
  };
}

module.exports = {
  createActivityService,
};
