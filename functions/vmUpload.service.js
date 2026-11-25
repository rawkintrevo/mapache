"use strict";

const crypto = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const {checkOwned} = require("./vmRead.service");
const {isVmAddress} = require("./vmGatewayResolve.service");
const {normalizeUploadOperationId, validateUpload} = require("./workspaceUploads.service");

const UPLOAD_ACCESS_TTL_MS = 60 * 60 * 1000;

function createVmUploadService({db, now = Date.now} = {}) {
  if (!db) throw new Error("vm_upload_db_required");

  async function createUpload({workspaceId, ownerUid, body}) {
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => !["expectedGeneration", "name", "operationId", "size"].includes(key)) ||
        !Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 1) {
      throw httpError(400, "invalid_vm_upload_request");
    }
    const {name, size} = validateUpload(body);
    const requestedOperationId = normalizeUploadOperationId(body.operationId);
    const operationId = requestedOperationId || crypto.randomUUID();
    const workspaceRef = db.collection("vmRuntimes_v2").doc(workspaceId);

    return db.runTransaction(async tx => {
      const workspace = (await tx.get(workspaceRef)).data();
      checkOwned(workspace, ownerUid);
      if (workspace.generation !== body.expectedGeneration) throw httpError(409, "vm_generation_mismatch");
      if (workspace.activeOperationId || workspace.state !== "active" ||
          workspace.lifecycleReadyGeneration !== workspace.generation || !workspace.bootId ||
          !(workspace.leaseExpiresAt > now())) throw httpError(409, "vm_not_ready");
      if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(workspace.gatewayHost || "")) {
        throw httpError(409, "vm_gateway_unavailable");
      }

      const sessionRef = workspaceRef.collection("sessions").doc(workspace.currentSessionId);
      const credentialsRef = db.collection("vmRuntimeCredentials_v2").doc(workspace.currentSessionId);
      const routeRef = db.collection("vmGatewayRoutes_v2").doc(workspace.gatewayHost);
      const [sessionSnapshot, credentialsSnapshot, routeSnapshot] = await Promise.all([
        tx.get(sessionRef), tx.get(credentialsRef), tx.get(routeRef),
      ]);
      const session = sessionSnapshot.data();
      const credentials = credentialsSnapshot.data();
      const route = routeSnapshot.data();
      if (!session || session.ownerUid !== ownerUid || session.generation !== workspace.generation ||
          session.state !== "active" || session.bootId !== workspace.bootId ||
          !(session.leaseExpiresAt > now()) || !credentials || credentials.ownerUid !== ownerUid ||
          credentials.generation !== workspace.generation || typeof credentials.browserToken !== "string" ||
          credentials.browserToken.length < 32 || !route || route.ownerUid !== ownerUid ||
          route.workspaceId !== workspaceId || route.sessionId !== workspace.currentSessionId ||
          route.generation !== workspace.generation || route.enabled !== true ||
          !isVmAddress(route.address)) throw httpError(409, "vm_upload_access_unavailable");

      const expiresAtMs = now() + UPLOAD_ACCESS_TTL_MS;
      const payload = Buffer.from(JSON.stringify({sid: workspace.currentSessionId,
        aud: "agent", gen: workspace.generation, exp: Math.floor(expiresAtMs / 1000)})).toString("base64url");
      const token = `${payload}.${crypto.createHmac("sha256", credentials.browserToken).update(payload).digest("base64url")}`;
      const uploadUrl = new URL(`/workspace/uploads/${operationId}`, `https://${workspace.gatewayHost}`);
      uploadUrl.searchParams.set("name", name);
      uploadUrl.searchParams.set("size", String(size));
      uploadUrl.searchParams.set("mapache_access", token);
      return {uploadUrl: uploadUrl.toString(), path: `/uploads/${name}`, size, mode: "retained-disk", operationId};
    });
  }

  return {createUpload};
}

module.exports = {UPLOAD_ACCESS_TTL_MS, createVmUploadService};
