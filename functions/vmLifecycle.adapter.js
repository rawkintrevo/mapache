"use strict";
const {createComputeEngineService} = require("./computeEngine.service");
const {createVmLifecycleService} = require("./vmLifecycle.service");
const {isVmAddress} = require("./vmGatewayResolve.service");
const {httpError} = require("./backendUtils.helpers");

function createVmLifecycleEffects({db, compute, fetchImpl = fetch}) {
  async function control(op, path) {
    const sessionId = path === "/shutdown" ? op.oldSessionId : op.sessionId;
    const credentials = (await db.collection("vmRuntimeCredentials_v2").doc(sessionId).get()).data();
    if (credentials?.ownerUid !== op.ownerUid) throw httpError(409, "vm_credentials_mismatch");
    return fetchImpl(`https://${op.gatewayHost}${path}`, {
      method: path === "/shutdown" ? "POST" : "GET", redirect: "error",
      headers: {"x-shutdown-token": credentials.shutdownToken}, signal: AbortSignal.timeout(path === "/shutdown" ? 120000 : 15000),
    });
  }
  return {
    quiesce: async op => {
      const session = (await db.doc(`vmRuntimes_v2/${op.workspaceId}/sessions/${op.oldSessionId}`).get()).data();
      if (!(session?.leaseExpiresAt > Date.now())) return {ok: false, reason: "lease_expired_delete_required"};
      try {
        const response = await control(op, "/shutdown");
        await response.body?.cancel();
        return {ok: response.ok, reason: response.ok ? "quiesced" : "quiesce_rejected_delete_required"};
      } catch { return {ok: false, reason: "quiesce_unreachable_delete_required"}; }
    },
    publishRoute: async op => {
      const observed = await compute.inspect(op.descriptor);
      if (!observed.instance || !isVmAddress(observed.instance.privateAddress)) throw httpError(409, "vm_private_target_not_ready");
      const wr = db.doc(`vmRuntimes_v2/${op.workspaceId}`);
      const routeRef = db.collection("vmGatewayRoutes_v2").doc(op.gatewayHost);
      await db.runTransaction(async tx => {
        const [w, r] = await Promise.all([tx.get(wr), tx.get(routeRef)]);
        const ws = w.data(); const route = r.data();
        if (ws?.ownerUid !== op.ownerUid || ws.activeOperationId !== op.operationId || ws.generation !== op.descriptor.generation || ws.currentSessionId !== op.sessionId ||
            !route || route.workspaceId !== op.workspaceId || route.ownerUid !== op.ownerUid || route.generation > op.descriptor.generation) throw httpError(409, "vm_route_authority_mismatch");
        tx.set(routeRef, {enabled: true, workspaceId: op.workspaceId, ownerUid: op.ownerUid,
          generation: op.descriptor.generation, sessionId: op.sessionId, address: observed.instance.privateAddress});
      });
    },
    health: async op => {
      try {
        const response = await control(op, "/runner/health");
        if (!response.ok) { await response.body?.cancel(); return false; }
        const result = await response.json();
        return result.sessionId === op.sessionId && result.agentRuntime?.ready === true;
      } catch { return false; }
    },
  };
}
function createVmLifecycleAdapter({db, claimMs, afterEffect}) {
  const compute = createComputeEngineService({projectId: "pi-agents-cloud"});
  return createVmLifecycleService({db, compute, claimMs, afterEffect, ...createVmLifecycleEffects({db, compute})});
}
module.exports = {createVmLifecycleAdapter, createVmLifecycleEffects};
