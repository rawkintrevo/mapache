"use strict";
const {httpError} = require("./backendUtils.helpers");
const {normalizeRuntimePolicy} = require("./runtimeSchedule.helpers");

function checkOwned(ws, uid) {
  if (!ws || ws.ownerUid !== uid || ws.backend !== "compute-engine" || ws.apiEnabled !== true) throw httpError(404, "not_found");
}
function publicWorkspace(id, ws, time) {
  const runtimePolicy = safeRuntimePolicy(ws);
  return {id, name: ws.name || "Workspace", backend: "compute-engine", generation: ws.generation, state: ws.state,
    canonicalSessionId: ws.currentSessionId || null, currentSessionId: ws.currentSessionId || null,
    activeOperationId: ws.activeOperationId || null,
    runtimePolicy, runtimePolicyRevision: Number.isSafeInteger(ws.runtimePolicyRevision) ? ws.runtimePolicyRevision : 0,
    runtimeScheduleError: safeRuntimeScheduleError(ws.runtimeScheduleError),
    runtimeScheduleManualPauseWindowKey: safeWindowKey(ws.runtimeScheduleManualPauseWindowKey),
    runtimeScheduleNextEvent: safeRuntimeScheduleEvent(ws.runtimeScheduleNextEvent),
    runtimeScheduleStatus: ["open", "closed", "manually_paused"].includes(ws.runtimeScheduleStatus) ? ws.runtimeScheduleStatus : null,
    ready: ws.state === "active" && !ws.activeOperationId && ws.lifecycleReadyGeneration === ws.generation && !!ws.bootId && ws.leaseExpiresAt > time};
}
function safeRuntimePolicy(ws = {}) {
  if (!ws.runtimePolicy) return {mode: "idle", schedule: null};
  try { return normalizeRuntimePolicy(ws.runtimePolicy); }
  catch { return {mode: "idle", schedule: null}; }
}
function safeWindowKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
function safeRuntimeScheduleEvent(value) {
  if (!value || typeof value !== "object" || !["start", "stop"].includes(value.action) || !safeWindowKey(value.windowKey) ||
      typeof value.timezone !== "string" || value.timezone.length > 100 || value.at == null) return null;
  return {action: value.action, at: value.at, windowKey: value.windowKey, timezone: value.timezone};
}
function safeRuntimeScheduleError(value) {
  if (!value || typeof value !== "object" || !["start", "stop", "pause", "reconcile"].includes(value.action) ||
      typeof value.code !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value.code)) return null;
  return {action: value.action, code: value.code, ...(value.at == null ? {} : {at: value.at})};
}
function createVmReadService({db, now = Date.now}) {
  return {
    async list(uid, query = {}) {
      if (!query || typeof query !== "object" || Array.isArray(query) || Object.keys(query).some(key => !["limit", "cursor"].includes(key)) ||
          (query.limit !== undefined && (!["string", "number"].includes(typeof query.limit) || !/^(?:[1-9][0-9]?|100)$/.test(String(query.limit)))) ||
          (query.cursor !== undefined && (typeof query.cursor !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(query.cursor)))) throw httpError(400, "invalid_vm_page");
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      let source = db.collection("vmRuntimes_v2").where("ownerUid", "==", uid)
          .where("apiEnabled", "==", true).where("backend", "==", "compute-engine").orderBy("__name__");
      if (query.cursor) source = source.startAfter(query.cursor);
      const page = await source.limit(limit + 1).get();
      const docs = page.docs.slice(0, limit);
      const time = now();
      return {workspaces: docs.map(doc => {
        const ws = doc.data(); checkOwned(ws, uid); return publicWorkspace(doc.id, ws, time);
      }), nextCursor: page.docs.length > limit ? docs[docs.length - 1].id : null};
    },
    async sessions(uid, workspaceId) {
      const wr = db.collection("vmRuntimes_v2").doc(workspaceId);
      return db.runTransaction(async tx => {
        const ws = (await tx.get(wr)).data(); checkOwned(ws, uid);
        const time = now(); const workspace = publicWorkspace(workspaceId, ws, time);
        if (!ws.currentSessionId) return {workspace, sessions: []};
        const session = (await tx.get(wr.collection("sessions").doc(ws.currentSessionId))).data();
        if (!session || session.ownerUid !== uid || session.generation !== ws.generation) throw httpError(409, "vm_session_mismatch");
        const ready = workspace.ready && session.state === "active" && session.bootId === ws.bootId && session.leaseExpiresAt > time;
        workspace.ready = ready;
        const status = ready ? "running" : ws.state === "stopping" ? "stopping" :
          ["stopped", "released"].includes(ws.state) ? "stopped" : ws.activeOperationId ? "provisioning" : "unavailable";
        return {workspace, sessions: [{id: ws.currentSessionId, workspaceId, name: ws.name || "Workspace",
          backend: "compute-engine", generation: ws.generation, runtimeKind: "main", agentUiVersion: "pi-web-ui-v1",
          longRunning: ws.runtimePolicy?.mode === "keep-running",
          idleTimeoutMinutes: Number.isSafeInteger(ws.machineConfig?.desired?.idleStopMinutes) ? ws.machineConfig.desired.idleStopMinutes : null,
          status, agentRuntimeState: ready ? "ready" : status, activeOperationId: ws.activeOperationId || null,
          // Access URLs are minted separately; no direct VM address or stored secret.
          serviceUrl: ready && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(ws.gatewayHost || "") ? `https://${ws.gatewayHost}` : null,
        }]};
      });
    },
  };
}
module.exports = {createVmReadService, checkOwned, publicWorkspace};
