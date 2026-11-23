"use strict";
const {createHash, randomBytes, randomUUID} = require("node:crypto");
const {normalizeRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {tokenHash} = require("./vmRuntimeControl.service");
const {httpError} = require("./backendUtils.helpers");
const {resolveVmEnvironment} = require("./vmEnvironment.service");

const OPERATIONS = "vmLifecycleOperations_v2";
// Workers have a hard 540-second platform timeout. Do not reclaim an uncertain
// cloud operation until that invocation is necessarily gone, plus a margin.
const CLAIM_MS = 15 * 60 * 1000;
function createVmLifecycleService({db, compute, quiesce, publishRoute, health, now = Date.now}) {
  const workspaceRef = id => db.collection("vmRuntimes_v2").doc(identifier(id));
  const opRef = id => db.collection(OPERATIONS).doc(identifier(id));
  async function request({workspaceId, ownerUid, requestId, action, expectedGeneration, requireApiAdmission = false}) {
    identifier(ownerUid); identifier(requestId);
    if (!["start", "pause", "replace"].includes(action)) throw httpError(400, "invalid_vm_action");
    const wr = workspaceRef(workspaceId);
    const id = createHash("sha256").update(`${workspaceId}:${requestId}`).digest("hex");
    const ref = opRef(id);
    return db.runTransaction(async tx => {
      const [w, existing] = await Promise.all([tx.get(wr), tx.get(ref)]);
      const ws = w.data();
      if (!ws || ws.ownerUid !== ownerUid || ws.backend !== "compute-engine") throw httpError(404, "not_found");
      if (requireApiAdmission && ws.apiEnabled !== true) throw httpError(404, "not_found");
      if (existing.exists) {
        const operation = existing.data();
        if (operation.ownerUid !== ownerUid || operation.action !== action || operation.oldGeneration !== expectedGeneration) throw httpError(409, "vm_request_id_conflict");
        return {operationId: id, status: operation.status};
      }
      if (ws.lifecycleEnabled !== true) throw httpError(409, "vm_lifecycle_not_admitted");
      if (ws.generation !== expectedGeneration) throw httpError(409, "vm_generation_mismatch");
      if (ws.activeOperationId) throw httpError(409, "vm_operation_in_progress");
      if ((action === "start" && ws.state !== "stopped") ||
          (action !== "start" && !["active", "released"].includes(ws.state))) throw httpError(409, "vm_state_conflict");
      if (!/^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/.test(ws.runnerImage || "") ||
          !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(ws.gatewayHost || "")) throw httpError(409, "vm_lifecycle_configuration_missing");
      const ss = (await tx.get(wr.collection("sessions").doc(identifier(ws.currentSessionId)))).data();
      if (!ss || ss.ownerUid !== ownerUid || ss.generation !== ws.generation) throw httpError(409, "vm_session_mismatch");
      const descriptor = normalizeRuntimeDescriptor(ss.runtimeProvider, {workspaceId, ownerUid});
      if (descriptor.backend !== "compute-engine" || descriptor.generation !== ws.generation) throw httpError(409, "vm_descriptor_mismatch");
      const operation = {workspaceId, ownerUid, action, oldGeneration: ws.generation,
        oldSessionId: ws.currentSessionId, descriptor, runnerImage: ws.runnerImage, gatewayHost: ws.gatewayHost,
        phase: action === "start" ? "delete" : "quiesce", status: "pending", claim: null,
        createdAtMs: now(), updatedAtMs: now()};
      tx.set(ref, operation);
      tx.update(wr, {activeOperationId: id, state: "stopping"});
      tx.update(wr.collection("sessions").doc(ws.currentSessionId), {state: "stopping"});
      return {operationId: id, status: "pending"};
    });
  }
  async function step(operationId) {
    const ref = opRef(operationId);
    const claimId = randomUUID();
    const operation = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const op = snap.data();
      if (!op || op.status !== "pending" || op.claim?.expiresAt > now() || op.nextAttemptAtMs > now()) return null;
      const ws = (await tx.get(workspaceRef(op.workspaceId))).data();
      assertOperation(ws, op, operationId);
      tx.update(ref, {claim: {id: claimId, expiresAt: now() + CLAIM_MS}, updatedAtMs: now()});
      return {...op, operationId};
    });
    if (!operation) return {claimed: false};
    const wr = workspaceRef(operation.workspaceId);
    const commit = async (nextPhase, fields = {}, workspaceFields = {}) => db.runTransaction(async tx => {
      const [snapshot, w] = await Promise.all([tx.get(ref), tx.get(wr)]);
      const op = snapshot.data();
      assertOperation(w.data(), op, operationId);
      if (op.claim?.id !== claimId || op.phase !== operation.phase || !(op.claim.expiresAt > now())) throw httpError(409, "vm_worker_claim_lost");
      if (op.phase === "health" && fields.status === "succeeded") {
        const session = (await tx.get(wr.collection("sessions").doc(op.sessionId))).data();
        const ws = w.data();
        if (ws.state !== "active" || ws.currentSessionId !== op.sessionId || !ws.bootId ||
            !(ws.leaseExpiresAt > now()) || session?.state !== "active" || session.bootId !== ws.bootId ||
            !(session.leaseExpiresAt > now())) throw httpError(409, "vm_readiness_authority_lost");
        if (op.configVersion) {
          if (session.configVersion !== op.configVersion || !ws.machineConfig || ws.machineConfig.desiredVersion < op.configVersion ||
              ws.machineConfig.appliedVersion > op.configVersion) throw httpError(409, "vm_configuration_authority_lost");
          workspaceFields.machineConfig = {...ws.machineConfig, appliedVersion: op.configVersion,
            state: ws.machineConfig.desiredVersion === op.configVersion ? "applied" : "pending-restart"};
        }
      }
      tx.update(ref, {phase: nextPhase, claim: null, lastError: null, updatedAtMs: now(), ...fields});
      if (Object.keys(workspaceFields).length) tx.update(wr, workspaceFields);
      if (workspaceFields.state === "stopped") tx.update(wr.collection("sessions").doc(op.oldSessionId), {state: "stopped", leaseExpiresAt: 0});
    });
    try {
      if (operation.phase === "disk") {
        if (operation.action !== "create" || operation.descriptor.generation !== 1) throw httpError(409, "vm_initial_disk_authority_missing");
        const ws = (await wr.get()).data();
        if (ws?.initialOperationId !== operationId || ws.bootId) throw httpError(409, "vm_initial_disk_authority_missing");
        await compute.ensureDataDisk(operation.descriptor, {operationId: `${operationId}-create`, allowCreateDisk: true, requireCreationMatch: true, timeoutMs: 240000});
        await commit("provision");
      } else if (operation.phase === "quiesce") {
        const result = await quiesce(operation);
        await commit("delete", {quiesceResult: result});
      } else if (operation.phase === "delete") {
        await compute.pause(operation.descriptor, {operationId: `${operationId}-delete`, timeoutMs: 240000});
        if (operation.action === "pause") {
          await commit("complete", {status: "succeeded", completedAtMs: now()},
              {state: "stopped", activeOperationId: null, leaseExpiresAt: 0, bootId: null});
        } else await commit("reserve");
      } else if (operation.phase === "reserve") {
        await db.runTransaction(async tx => {
          const [snapshot, w] = await Promise.all([tx.get(ref), tx.get(wr)]);
          const op = snapshot.data();
          assertOperation(w.data(), op, operationId);
          if (op.claim?.id !== claimId || op.phase !== "reserve" || !(op.claim.expiresAt > now())) throw httpError(409, "vm_worker_claim_lost");
          const generation = operation.oldGeneration + 1;
          const sessionId = `vm-${operationId.slice(0, 24)}-g${generation}`;
          const sr = wr.collection("sessions").doc(sessionId);
          const cr = db.collection("vmRuntimeCredentials_v2").doc(sessionId);
          const [s, c, old] = await Promise.all([tx.get(sr), tx.get(cr), tx.get(wr.collection("sessions").doc(operation.oldSessionId))]);
          if (s.exists || c.exists) throw httpError(409, "vm_reservation_conflict");
          const saved = old.data();
          if (saved?.ownerUid !== operation.ownerUid || saved.generation !== operation.oldGeneration) throw httpError(409, "vm_previous_session_mismatch");
          const descriptor = normalizeRuntimeDescriptor({...operation.descriptor, generation, instanceName: null});
          const secrets = {ownerUid: operation.ownerUid, generation, controlToken: randomBytes(32).toString("hex"),
            browserToken: randomBytes(32).toString("hex"), shutdownToken: randomBytes(32).toString("hex")};
          const config = w.data().machineConfig;
          const selected = config?.desired || saved;
          const configVersion = config?.desiredVersion || 0;
          tx.set(cr, secrets);
          tx.set(sr, {ownerUid: operation.ownerUid, generation, state: "reserved", runtimeProvider: descriptor,
            authSelection: selected.authSelection || {harness: "pi", providers: {}}, piScopedModels: saved.piScopedModels || [],
            environmentEntryIds: selected.environmentEntryIds || [], configVersion,
            controlTokenHash: tokenHash(secrets.controlToken)});
          tx.update(wr, {generation, currentSessionId: sessionId, state: "reserved", bootId: null, leaseExpiresAt: 0});
          tx.update(ref, {phase: "provision", descriptor, sessionId, configVersion, claim: null, updatedAtMs: now()});
        });
      } else if (operation.phase === "provision") {
        const currentWorkspace = (await wr.get()).data();
        assertOperation(currentWorkspace, operation, operationId);
        const credentials = (await db.collection("vmRuntimeCredentials_v2").doc(operation.sessionId).get()).data();
        if (credentials?.ownerUid !== operation.ownerUid || credentials.generation !== operation.descriptor.generation) throw httpError(409, "vm_credentials_mismatch");
        const session = (await wr.collection("sessions").doc(operation.sessionId).get()).data();
        if (session?.ownerUid !== operation.ownerUid || session.generation !== operation.descriptor.generation) throw httpError(409, "vm_session_mismatch");
        const environment = await resolveVmEnvironment({db, ownerUid: operation.ownerUid, entryIds: session.environmentEntryIds || []});
        await compute.start(operation.descriptor, {operationId: `${operationId}-create`, timeoutMs: 240000,
          allowCreateDisk: false, allowInitializeDisk: operation.action === "create" && operation.descriptor.generation === 1 &&
            currentWorkspace.initialOperationId === operationId && !currentWorkspace.bootId,
          runnerImage: operation.runnerImage,
          subnetwork: "projects/pi-agents-cloud/regions/us-central1/subnetworks/mapache-vm-v2-us-central1",
          env: {...environment, GCLOUD_PROJECT: "pi-agents-cloud", MAPACHE_AGENT_UI_VERSION: "pi-web-ui-v1",
            MAPACHE_VM_CONTROL_URL: "https://us-central1-pi-agents-cloud.cloudfunctions.net/vmRuntimeControl_v2",
            MAPACHE_VM_CONTROL_TOKEN: credentials.controlToken, SESSION_ID: operation.sessionId,
            SESSION_BROWSER_TOKEN_SECRET: credentials.browserToken, SESSION_SHUTDOWN_TOKEN: credentials.shutdownToken,
            MAPACHE_PI_MODEL_CATALOG_REFRESH: "false",
            RUNNER_CAPABILITIES: JSON.stringify({terminal: true, preview: true, chrome: false, previewQa: false, functions: false})}});
        await commit("route");
      } else if (operation.phase === "route") {
        await publishRoute(operation);
        await commit("health");
      } else if (operation.phase === "health") {
        const ready = await health(operation);
        if (ready) await commit("complete", {status: "succeeded", completedAtMs: now()}, {activeOperationId: null, lifecycleReadyGeneration: operation.descriptor.generation});
        else await commit("health", {nextAttemptAtMs: now() + 15000});
      } else throw httpError(409, "vm_operation_phase_invalid");
      return {claimed: true};
    } catch (error) {
      // Retain the claim after uncertain effects. A later bounded invocation
      // reconciles the same phase and operation ID; it never releases admission.
      await db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current?.claim?.id === claimId) tx.update(ref, {lastError: error.publicMessage || error.code || "vm_operation_failed", updatedAtMs: now()});
      });
      throw error;
    }
  }
  return {request, step};
}
function assertOperation(ws, op, operationId) {
  if (!ws || !op || ws.ownerUid !== op.ownerUid || ws.activeOperationId !== operationId ||
      ws.backend !== "compute-engine" || ws.generation !== op.descriptor.generation) throw httpError(409, "vm_operation_authority_lost");
}
function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw httpError(400, "invalid_identity");
  return value;
}
module.exports = {createVmLifecycleService, OPERATIONS, CLAIM_MS};
