"use strict";

const {latestTimestampMillis} = require("./backendUtils.helpers");
const {normalizeVmIdleStopMinutes} = require("./vmConfiguration.service");

const MAX_SCAN = 100;

function isIdleVmWorkspace(workspace, session, now = Date.now) {
  if (!workspace || workspace.backend !== "compute-engine" || workspace.lifecycleEnabled !== true ||
      workspace.state !== "active" || workspace.activeOperationId || !workspace.currentSessionId ||
      !session || session.state !== "active" || session.generation !== workspace.generation ||
      Number(session.activeSocketCount || 0) > 0) return false;
  let idleStopMinutes;
  try { idleStopMinutes = normalizeVmIdleStopMinutes(workspace.machineConfig?.desired?.idleStopMinutes); }
  catch { return false; }
  if (idleStopMinutes === null) return false;
  const baseline = latestTimestampMillis(session.runtimeStartedAt, session.lastActivityAt);
  return baseline > 0 && now() - baseline >= idleStopMinutes * 60 * 1000;
}

async function reconcileIdleVmWorkspaces({firestore, lifecycle, now = Date.now, max = MAX_SCAN} = {}) {
  if (!firestore || !lifecycle || typeof lifecycle.request !== "function") throw new Error("vm_idle_reconcile_dependencies_required");
  const snapshot = await firestore.collection("vmRuntimes_v2").limit(max).get();
  const scanned = Array.isArray(snapshot.docs) ? snapshot.docs : [];
  const tick = Math.floor(now() / 60000);
  const results = await Promise.allSettled(scanned.map(async doc => {
    const workspace = doc.data() || {};
    if (!workspace.ownerUid || !workspace.currentSessionId) return {skipped: true};
    const session = (await firestore.collection("vmRuntimes_v2").doc(doc.id)
      .collection("sessions").doc(workspace.currentSessionId).get()).data();
    if (!isIdleVmWorkspace(workspace, session, now)) return {skipped: true};
    const request = await lifecycle.request({workspaceId: doc.id, ownerUid: workspace.ownerUid,
      action: "pause", expectedGeneration: workspace.generation, requestId: `idle-${tick}`});
    return {requested: true, operationId: request.operationId || null};
  }));
  return {
    scanned: scanned.length,
    requested: results.filter(result => result.status === "fulfilled" && result.value.requested).length,
    skipped: results.filter(result => result.status === "fulfilled" && result.value.skipped).length,
    failed: results.filter(result => result.status === "rejected").length,
    results,
  };
}

module.exports = {MAX_SCAN, isIdleVmWorkspace, reconcileIdleVmWorkspaces};
