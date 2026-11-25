"use strict";
const {httpError} = require("./backendUtils.helpers");
const {checkOwned} = require("./vmRead.service");
const {normalizeEnvironmentEntryIds} = require("./environmentKeys.service");
const {normalizePiAuthEntries, normalizePiAuthProviders, normalizePiAuthSelection} = require("./agentAuth.service");
const {resolveVmEnvironment} = require("./vmEnvironment.service");
const {normalizeSessionResources} = require("./sessionResources.helpers");

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function normalizeVmDescription(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw httpError(400, "invalid_vm_description");
  return value.trim().slice(0, 1000);
}
function normalizeVmIdleStopMinutes(value) {
  if (value === undefined || value === null || value === "") return null;
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 1440) {
    throw httpError(400, "invalid_vm_idle_stop_minutes");
  }
  return minutes;
}
function selections(value = {}) {
  const auth = value.authSelection || {harness: "pi", providers: {}};
  const ids = value.environmentEntryIds || [];
  if (!object(auth) || auth.harness !== "pi" || !object(auth.providers) ||
      Object.keys(auth.providers).length > 50 ||
      Object.keys(auth).some(k => !["harness", "providers"].includes(k)) ||
      Object.entries(auth.providers).some(([key, id]) => !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key) || typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(id)) ||
      !Array.isArray(ids) || ids.length > 50) throw httpError(400, "invalid_vm_configuration");
  let resources = null;
  if (value.resources !== undefined && value.resources !== null) resources = normalizeSessionResources(value.resources, {defaultResources: null});
  const diskSizeGb = value.diskSizeGb === undefined || value.diskSizeGb === null || value.diskSizeGb === "" ? null : Number(value.diskSizeGb);
  if (diskSizeGb !== null && (!Number.isSafeInteger(diskSizeGb) || diskSizeGb < 10 || diskSizeGb > 4096)) {
    throw httpError(400, "invalid_vm_disk_size_gb");
  }
  const description = normalizeVmDescription(value.description);
  const idleStopMinutes = normalizeVmIdleStopMinutes(value.idleStopMinutes);
  return {authSelection: {harness: "pi", providers: {...auth.providers}}, environmentEntryIds: normalizeEnvironmentEntryIds(ids),
    resources, diskSizeGb, description, idleStopMinutes};
}

function restartSensitiveConfiguration(value = {}) {
  return JSON.stringify({authSelection: value.authSelection || {harness: "pi", providers: {}},
    environmentEntryIds: value.environmentEntryIds || [], resources: value.resources || null, diskSizeGb: value.diskSizeGb ?? null});
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
      if (!object(patch) || Object.keys(patch).some(k => !["expectedGeneration", "expectedVersion", "authSelection", "environmentEntryIds", "resources", "diskSizeGb", "description", "idleStopMinutes"].includes(k)) ||
          !Number.isSafeInteger(patch.expectedGeneration) || !Number.isSafeInteger(patch.expectedVersion) || patch.expectedVersion < 0 ||
          (!["authSelection", "environmentEntryIds", "resources", "diskSizeGb", "description", "idleStopMinutes"].some(key => Object.hasOwn(patch, key))) ||
          (Object.hasOwn(patch, "authSelection") && !object(patch.authSelection)) ||
          (Object.hasOwn(patch, "environmentEntryIds") && !Array.isArray(patch.environmentEntryIds)) ||
          (Object.hasOwn(patch, "resources") && patch.resources !== null && !object(patch.resources)) ||
          (Object.hasOwn(patch, "description") && patch.description !== null && typeof patch.description !== "string")) throw httpError(400, "invalid_vm_configuration");
      if (ws.generation !== patch.expectedGeneration) throw httpError(409, "vm_generation_mismatch");
      if (desiredVersion !== patch.expectedVersion) throw httpError(409, "vm_configuration_version_mismatch");
      if (desiredVersion >= Number.MAX_SAFE_INTEGER) throw httpError(409, "vm_configuration_version_exhausted");
      if (ws.activeOperationId) throw httpError(409, "vm_operation_in_progress");
      const next = selections({...desired, ...patch});
      if (desired.diskSizeGb !== null && next.diskSizeGb !== null && next.diskSizeGb < desired.diskSizeGb) {
        throw httpError(409, "vm_disk_shrink_unsupported");
      }
      // Validate owner-private references within the same transaction as the
      // version change. Neither secret values nor credentials enter the DTO.
      await resolveVmEnvironment({db, ownerUid, entryIds: next.environmentEntryIds, read: ref => tx.get(ref)});
      const auth = (await tx.get(db.collection("users").doc(ownerUid).collection("private").doc("agentAuth"))).data() || {};
      const entries = normalizePiAuthEntries(auth.entries, normalizePiAuthProviders(auth.providers));
      const normalized = normalizePiAuthSelection(next.authSelection.providers, entries);
      if (Object.entries(next.authSelection.providers).some(([provider, id]) => normalized[provider] !== id)) throw httpError(409, "vm_auth_entry_unavailable");
      const nextVersion = desiredVersion + 1;
      const restartRequired = restartSensitiveConfiguration(desired) !== restartSensitiveConfiguration(next);
      const nextAppliedVersion = restartRequired ? appliedVersion : nextVersion;
      const config = {desiredVersion: nextVersion, appliedVersion: nextAppliedVersion, desired: next,
        state: restartRequired ? "pending-restart" : "applied", updatedAtMs: now()};
      tx.update(wr, {machineConfig: config});
      return {generation: ws.generation, desiredVersion: config.desiredVersion, appliedVersion: nextAppliedVersion,
        desired: next, state: config.state, restartRequired};
    });
  };
}

module.exports = {createVmConfigurationService, normalizeVmDescription, normalizeVmIdleStopMinutes};
