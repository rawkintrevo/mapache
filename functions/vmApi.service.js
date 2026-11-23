"use strict";
const {createHmac} = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const {OPERATIONS} = require("./vmLifecycle.service");
const {isVmAddress} = require("./vmGatewayResolve.service");
const {createVmCreationService} = require("./vmCreation.service");
const {createVmReadService, checkOwned, publicWorkspace} = require("./vmRead.service");

const ACCESS_TTL_MS = 15 * 60 * 1000;
function createVmApiService({db, requireUser, lifecycle, now = Date.now}) {
  return async function handle(req) {
    const user = await requireUser(req);
    const uid = user.uid || user.id;
    if (!uid) throw httpError(401, "invalid_auth_token");
    const reads = createVmReadService({db, now});
    if (/^\/workspaces\/?$/.test(req.path || "") && req.method === "GET") return {status: 200, body: await reads.list(uid, req.query)};
    const match = String(req.path || "").match(/^\/workspaces\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/(create|sessions|access|start|pause|replace|operations)(?:\/([a-f0-9]{64}))?)?\/?$/);
    if (!match) throw httpError(404, "not_found");
    const [, workspaceId, action, operationId] = match;
    const wr = db.collection("vmRuntimes_v2").doc(workspaceId);
    if (action === "sessions" && !operationId && req.method === "GET") return {status: 200, body: await reads.sessions(uid, workspaceId)};
    if (action === "create" && !operationId && req.method === "POST") {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["requestId", "name"].includes(key))) throw httpError(400, "invalid_vm_request");
      const result = await createVmCreationService({db, now})({workspaceId, ownerUid: uid, requestId: body.requestId, name: body.name});
      return {status: 202, body: result};
    }
    if (!action && req.method === "GET") {
      const ws = await ownedWorkspace(wr, uid);
      return {status: 200, body: {workspace: publicWorkspace(workspaceId, ws, now())}};
    }
    if (action === "operations" && operationId && req.method === "GET") {
      await ownedWorkspace(wr, uid);
      const op = (await db.collection(OPERATIONS).doc(operationId).get()).data();
      if (!op || op.ownerUid !== uid || op.workspaceId !== workspaceId) throw httpError(404, "not_found");
      return {status: 200, body: {operationId, action: op.action, status: op.status, phase: op.phase,
        generation: op.descriptor.generation, lastError: op.lastError || null, quiesceResult: op.quiesceResult || null}};
    }
    if (req.method !== "POST" || operationId || !["access", "start", "pause", "replace"].includes(action)) throw httpError(405, "method_not_allowed");
    const body = req.body || {};
    const fields = action === "access" ? ["expectedGeneration"] : ["expectedGeneration", "requestId"];
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key)) ||
        !Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 1) throw httpError(400, "invalid_vm_request");
    if (action !== "access") {
      await ownedWorkspace(wr, uid);
      // Owner is derived solely from Firebase Auth. Request bodies cannot select
      // an owner, image, upstream, credentials, runtime generation or disk.
      const result = await lifecycle.request({workspaceId, ownerUid: uid, action,
        requestId: body.requestId, expectedGeneration: body.expectedGeneration, requireApiAdmission: true});
      return {status: 202, body: result};
    }
    return db.runTransaction(async tx => {
      const ws = (await tx.get(wr)).data();
      checkOwned(ws, uid);
      if (ws.generation !== body.expectedGeneration) throw httpError(409, "vm_generation_mismatch");
      const time = now();
      if (ws.state !== "active" || ws.activeOperationId || ws.lifecycleReadyGeneration !== ws.generation ||
          !(ws.leaseExpiresAt > time) || !ws.currentSessionId || !ws.bootId) throw httpError(409, "vm_not_ready");
      if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(ws.gatewayHost || "")) throw httpError(409, "vm_gateway_unavailable");
      const [ss, cs, rs] = await Promise.all([
        tx.get(wr.collection("sessions").doc(ws.currentSessionId)),
        tx.get(db.collection("vmRuntimeCredentials_v2").doc(ws.currentSessionId)),
        tx.get(db.collection("vmGatewayRoutes_v2").doc(ws.gatewayHost)),
      ]);
      const session = ss.data(); const credentials = cs.data(); const route = rs.data();
      if (!session || !credentials || !route || session.ownerUid !== uid || credentials.ownerUid !== uid || route.ownerUid !== uid ||
          session.generation !== ws.generation || credentials.generation !== ws.generation || route.generation !== ws.generation ||
          session.state !== "active" || session.bootId !== ws.bootId || !(session.leaseExpiresAt > time) ||
          route.workspaceId !== workspaceId || route.sessionId !== ws.currentSessionId || route.enabled !== true ||
          !isVmAddress(route.address) || typeof credentials.browserToken !== "string" || credentials.browserToken.length < 32) throw httpError(409, "vm_access_authority_mismatch");
      const expiresAt = time + ACCESS_TTL_MS;
      const payload = Buffer.from(JSON.stringify({sid: ws.currentSessionId, aud: "agent", gen: ws.generation,
        exp: Math.floor(expiresAt / 1000)})).toString("base64url");
      const token = `${payload}.${createHmac("sha256", credentials.browserToken).update(payload).digest("base64url")}`;
      const url = path => `https://${ws.gatewayHost}${path}?mapache_access=${encodeURIComponent(token)}`;
      // One generation/audience token works on every runner surface. Opening a
      // shell/preview must not overwrite the shared cookie with an agent-invalid token.
      return {status: 200, body: {ok: true, workspaceId, sessionId: ws.currentSessionId, generation: ws.generation,
        expiresAt: new Date(expiresAt).toISOString(), agentUrl: url("/agent/"), terminalUrl: url("/shell"),
        previewUrl: url("/preview/"), browserUrl: session.capabilities?.chrome === true ? url("/browser/") : null}};
    });
  };
  async function ownedWorkspace(ref, uid) {
    const ws = (await ref.get()).data(); checkOwned(ws, uid); return ws;
  }
}
module.exports = {createVmApiService, ACCESS_TTL_MS};
