"use strict";
const {httpError} = require("./backendUtils.helpers");
const {checkOwned} = require("./vmRead.service");
const {normalizeEnvironmentEntryIds} = require("./environmentKeys.service");
const {normalizePiAuthEntries, normalizePiAuthProviders, normalizePiAuthSelection} = require("./agentAuth.service");
const {resolveVmEnvironment} = require("./vmEnvironment.service");

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function selections(value = {}) {
  const auth = value.authSelection || {harness: "pi", providers: {}};
  const ids = value.environmentEntryIds || [];
  if (!object(auth) || auth.harness !== "pi" || !object(auth.providers) ||
      Object.keys(auth.providers).length > 50 ||
      Object.keys(auth).some(k => !["harness", "providers"].includes(k)) ||
      Object.entries(auth.providers).some(([key, id]) => !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key) || typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(id)) ||
      !Array.isArray(ids) || ids.length > 50) throw httpError(400, "invalid_vm_configuration");
  return {authSelection: {harness: "pi", providers: {...auth.providers}}, environmentEntryIds: normalizeEnvironmentEntryIds(ids)};
}

function createVmConfigurationService({db, now = Date.now}) {
  return async function configuration({workspaceId, ownerUid, patch}) {
    const wr = db.collection("vmRuntimes_v2").doc(workspaceId);
    return db.runTransaction(async tx => {
      const ws = (await tx.get(wr)).data();
      checkOwned(ws, ownerUid);
      const session = (await tx.get(wr.collection("sessions").doc(ws.currentSessionId))).data();
      if (session?.ownerUid !== ownerUid || session.generation !== ws.generation) throw httpError(409, "vm_session_mismatch");
      const existing = ws.machineConfig;
      const desiredVersion = existing?.desiredVersion || 0;
      const appliedVersion = existing?.appliedVersion || 0;
      const desired = selections(existing?.desired || session);
      if (patch === undefined) return {generation: ws.generation, desiredVersion, appliedVersion, desired,
        state: existing?.state || "unversioned", restartRequired: desiredVersion !== appliedVersion};
      if (!object(patch) || Object.keys(patch).some(k => !["expectedGeneration", "expectedVersion", "authSelection", "environmentEntryIds"].includes(k)) ||
          !Number.isSafeInteger(patch.expectedGeneration) || !Number.isSafeInteger(patch.expectedVersion) || patch.expectedVersion < 0 ||
          (!Object.hasOwn(patch, "authSelection") && !Object.hasOwn(patch, "environmentEntryIds")) ||
          (Object.hasOwn(patch, "authSelection") && !object(patch.authSelection)) ||
          (Object.hasOwn(patch, "environmentEntryIds") && !Array.isArray(patch.environmentEntryIds))) throw httpError(400, "invalid_vm_configuration");
      if (ws.generation !== patch.expectedGeneration) throw httpError(409, "vm_generation_mismatch");
      if (desiredVersion !== patch.expectedVersion) throw httpError(409, "vm_configuration_version_mismatch");
      if (desiredVersion >= Number.MAX_SAFE_INTEGER) throw httpError(409, "vm_configuration_version_exhausted");
      if (ws.activeOperationId) throw httpError(409, "vm_operation_in_progress");
      const next = selections({...desired, ...patch});
      // Validate owner-private references within the same transaction as the
      // version change. Neither secret values nor credentials enter the DTO.
      await resolveVmEnvironment({db, ownerUid, entryIds: next.environmentEntryIds, read: ref => tx.get(ref)});
      const auth = (await tx.get(db.collection("users").doc(ownerUid).collection("private").doc("agentAuth"))).data() || {};
      const entries = normalizePiAuthEntries(auth.entries, normalizePiAuthProviders(auth.providers));
      const normalized = normalizePiAuthSelection(next.authSelection.providers, entries);
      if (Object.entries(next.authSelection.providers).some(([provider, id]) => normalized[provider] !== id)) throw httpError(409, "vm_auth_entry_unavailable");
      const config = {desiredVersion: desiredVersion + 1, appliedVersion, desired: next,
        state: "pending-restart", updatedAtMs: now()};
      tx.update(wr, {machineConfig: config});
      return {generation: ws.generation, desiredVersion: config.desiredVersion, appliedVersion,
        desired: next, state: config.state, restartRequired: true};
    });
  };
}

module.exports = {createVmConfigurationService};
