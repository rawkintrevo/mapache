"use strict";
const {createHash, randomBytes} = require("node:crypto");
const {createRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {tokenHash} = require("./vmRuntimeControl.service");
const {httpError} = require("./backendUtils.helpers");

// Backend-authored, single-workspace admissions keep creation bounded while
// gateway host allocation and migration cohort policy are being rolled out.
function createVmCreationService({db, now = Date.now}) {
  return async function create({workspaceId, ownerUid, requestId, name}) {
    for (const id of [workspaceId, ownerUid, requestId]) {
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw httpError(400, "invalid_identity");
    }
    if (typeof name !== "string" || !name.trim() || name.trim().length > 100) throw httpError(400, "invalid_workspace_name");
    name = name.trim();
    const operationId = createHash("sha256").update(`${workspaceId}:${requestId}`).digest("hex");
    const sessionId = `vm-${operationId.slice(0, 24)}-g1`;
    const wr = db.doc(`vmRuntimes_v2/${workspaceId}`);
    const ar = db.doc(`vmCreationAdmissions_v2/${workspaceId}`);
    const or = db.doc(`vmLifecycleOperations_v2/${operationId}`);
    return db.runTransaction(async tx => {
      const [a, w, o, legacy] = await Promise.all([tx.get(ar), tx.get(wr), tx.get(or), tx.get(db.doc(`workspaces/${workspaceId}`))]);
      const admission = a.data(); const ws = w.data(); const op = o.data();
      if (!admission || admission.ownerUid !== ownerUid || admission.enabled !== true) throw httpError(404, "not_found");
      if (op) {
        if (op.ownerUid !== ownerUid || op.action !== "create" || op.name !== name || ws?.initialOperationId !== operationId || ws.apiEnabled !== true) throw httpError(409, "vm_request_id_conflict");
        return {workspaceId, operationId, status: op.status};
      }
      if (w.exists || legacy.exists || admission.operationId) throw httpError(409, "vm_workspace_already_exists");
      if (!/^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/.test(admission.runnerImage || "") ||
          !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(admission.gatewayHost || "")) throw httpError(409, "vm_creation_configuration_missing");
      const rr = db.doc(`vmGatewayRoutes_v2/${admission.gatewayHost}`);
      const sr = wr.collection("sessions").doc(sessionId);
      const cr = db.doc(`vmRuntimeCredentials_v2/${sessionId}`);
      const [r, s, c] = await Promise.all([tx.get(rr), tx.get(sr), tx.get(cr)]);
      // Never steal an origin, including a disabled route left by another VM.
      if (r.exists || s.exists || c.exists) throw httpError(409, "vm_creation_resource_conflict");
      const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId, ownerUid,
        region: "us-central1", zone: "us-central1-a", generation: 1});
      const secrets = {ownerUid, generation: 1, controlToken: randomBytes(32).toString("hex"),
        browserToken: randomBytes(32).toString("hex"), shutdownToken: randomBytes(32).toString("hex")};
      tx.set(cr, secrets);
      tx.set(sr, {ownerUid, generation: 1, state: "reserved", runtimeProvider: descriptor,
        authSelection: {harness: "pi", providers: {}}, piScopedModels: [], controlTokenHash: tokenHash(secrets.controlToken)});
      tx.set(wr, {ownerUid, name, backend: "compute-engine", generation: 1, state: "reserved", currentSessionId: sessionId,
        apiEnabled: true, lifecycleEnabled: true, runnerImage: admission.runnerImage, gatewayHost: admission.gatewayHost,
        activeOperationId: operationId, initialOperationId: operationId, bootId: null, leaseExpiresAt: 0});
      tx.set(rr, {ownerUid, workspaceId, generation: 1, sessionId, enabled: false});
      tx.set(or, {workspaceId, ownerUid, name, action: "create", oldGeneration: 0, descriptor, sessionId,
        runnerImage: admission.runnerImage, gatewayHost: admission.gatewayHost, phase: "disk", status: "pending",
        claim: null, createdAtMs: now(), updatedAtMs: now()});
      tx.update(ar, {operationId, consumedAtMs: now()});
      return {workspaceId, operationId, status: "pending"};
    });
  };
}
module.exports = {createVmCreationService};
