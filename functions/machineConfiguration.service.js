"use strict";

const {admin: defaultAdmin, db: defaultDb} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");
const {normalizeSessionResources} = require("./sessionResources.helpers");
const {REMOTE_LIBVIRT_BACKEND} = require("./runtimeProvider.helpers");

const CONFIG_VERSION = 1;
const MAX_DESCRIPTION_LENGTH = 1000;

function createMachineConfigurationService(dependencies = {}) {
  const admin = dependencies.admin || defaultAdmin;
  const database = dependencies.db || defaultDb;
  const requireWorkspace = dependencies.requireWorkspace;
  return {
    getConfiguration: (uid, workspaceId) => getConfiguration(uid, workspaceId),
    updateConfiguration: (uid, workspaceId, payload) => updateConfiguration(uid, workspaceId, payload),
    markApplied: (workspaceId, appliedVersion) => markApplied(workspaceId, appliedVersion),
  };

  async function getConfiguration(uid, workspaceId) {
    const workspace = await loadWorkspace(uid, workspaceId);
    return safeConfiguration(workspace.machineConfig);
  }

  async function updateConfiguration(uid, workspaceId, payload = {}) {
    const ref = database.collection("workspaces").doc(workspaceId);
    let result;
    await database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw httpError(404, "workspace_not_found");
      const workspace = snapshot.data() || {};
      if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
      if (workspace.deleted === true || workspace.lifecycle === "deleting") throw httpError(409, "workspace_deleted");
      if (isRemoteWorkspace(workspace) && hasRemoteUnsupportedFields(payload)) {
        throw httpError(409, "remote_vm_configuration_unsupported");
      }
      const current = normalizeStoredConfiguration(workspace.machineConfig);
      if (payload.expectedVersion !== undefined && Number(payload.expectedVersion) !== current.desiredVersion) {
        throw httpError(409, "machine_configuration_conflict");
      }
      const desired = normalizeDesiredConfiguration(payload, current.desired);
      const desiredVersion = current.desiredVersion + 1;
      const active = await hasActiveSession(transaction, ref);
      const restartChanged = JSON.stringify(desired.resources) !== JSON.stringify(current.desired.resources) ||
        desired.diskSizeGb !== current.desired.diskSizeGb || desired.gatewayId !== current.desired.gatewayId;
      const state = active && restartChanged ? "pending-restart" : "pending";
      const value = {
        version: CONFIG_VERSION,
        desiredVersion,
        appliedVersion: current.appliedVersion,
        state,
        desired,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      transaction.update(ref, {machineConfig: value, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
      result = safeConfiguration(value);
    });
    return result;
  }

  async function markApplied(workspaceId, appliedVersion) {
    const ref = database.collection("workspaces").doc(workspaceId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return null;
    const current = normalizeStoredConfiguration(snapshot.data()?.machineConfig);
    const version = Number(appliedVersion);
    if (!Number.isSafeInteger(version) || version < 0 || version > current.desiredVersion) return safeConfiguration(current);
    const state = version === current.desiredVersion ? "applied" : "pending";
    await ref.update({machineConfig: {...current, appliedVersion: version, state, updatedAt: admin.firestore.FieldValue.serverTimestamp()}});
    return safeConfiguration({...current, appliedVersion: version, state});
  }

  async function loadWorkspace(uid, workspaceId) {
    if (typeof requireWorkspace === "function") return requireWorkspace(uid, workspaceId);
    const snapshot = await database.collection("workspaces").doc(workspaceId).get();
    if (!snapshot.exists) throw httpError(404, "workspace_not_found");
    const workspace = snapshot.data() || {};
    if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
    return workspace;
  }
}

function isRemoteWorkspace(workspace = {}) {
  return workspace.runtimeProvider?.backend === REMOTE_LIBVIRT_BACKEND || workspace.source?.type === REMOTE_LIBVIRT_BACKEND;
}

function hasRemoteUnsupportedFields(payload = {}) {
  return ["resources", "diskSizeGb", "idleStopMinutes", "gatewayId"].some((field) =>
    Object.prototype.hasOwnProperty.call(payload, field));
}

async function hasActiveSession(transaction, workspaceRef) {
  const sessions = await transaction.get(workspaceRef.collection("sessions"));
  return (sessions.docs || []).some((doc) => ["provisioning", "running", "ready", "restarting", "resizing", "stopping"].includes(String(doc.data()?.status || "").toLowerCase()));
}

function normalizeStoredConfiguration(value = {}) {
  const desired = normalizeDesiredConfiguration(value.desired || {}, {});
  return {
    version: Number(value.version) === CONFIG_VERSION ? CONFIG_VERSION : CONFIG_VERSION,
    desiredVersion: Number.isSafeInteger(Number(value.desiredVersion)) && Number(value.desiredVersion) >= 0 ? Number(value.desiredVersion) : 0,
    appliedVersion: Number.isSafeInteger(Number(value.appliedVersion)) && Number(value.appliedVersion) >= 0 ? Number(value.appliedVersion) : 0,
    state: String(value.state || "applied").trim().toLowerCase() || "applied",
    desired,
  };
}

function normalizeDesiredConfiguration(payload = {}, fallback = {}) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const fallbackValue = fallback && typeof fallback === "object" ? fallback : {};
  let resources = fallbackValue.resources || null;
  if (source.resources !== undefined) resources = normalizeSessionResources(source.resources || {});
  const environmentEntryIds = normalizeIds(source.environmentEntryIds ?? fallbackValue.environmentEntryIds);
  const piAuthEntryId = normalizeId(source.piAuthEntryId ?? fallbackValue.piAuthEntryId);
  const googleConnectionId = normalizeId(source.googleConnectionId ?? fallbackValue.googleConnectionId);
  const gatewayId = normalizeId(source.gatewayId ?? fallbackValue.gatewayId);
  const diskSizeGb = source.diskSizeGb === undefined ? fallbackValue.diskSizeGb ?? null : normalizeDiskSizeGb(source.diskSizeGb);
  const description = String(source.description ?? fallbackValue.description ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH);
  const idleStopMinutes = source.idleStopMinutes === undefined ? fallbackValue.idleStopMinutes ?? null : normalizeIdleStopMinutes(source.idleStopMinutes);
  return {description, resources, diskSizeGb, idleStopMinutes, piAuthEntryId, environmentEntryIds, googleConnectionId, gatewayId};
}

function safeConfiguration(value) {
  const normalized = normalizeStoredConfiguration(value);
  return {
    version: normalized.version,
    desiredVersion: normalized.desiredVersion,
    appliedVersion: normalized.appliedVersion,
    state: normalized.state,
    desired: normalized.desired,
    pending: normalized.desiredVersion !== normalized.appliedVersion,
  };
}

function normalizeId(value) {
  const id = String(value || "").trim();
  if (!id) return null;
  if (id.length > 160 || /[^A-Za-z0-9_.:-]/.test(id)) throw httpError(400, "invalid_machine_configuration_id");
  return id;
}

function normalizeIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw httpError(400, "invalid_machine_configuration_ids");
  return [...new Set(value.map(normalizeId).filter(Boolean))].slice(0, 100);
}

function normalizeIdleStopMinutes(value) {
  if (value === null || value === "") return null;
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 1440) throw httpError(400, "invalid_machine_idle_stop_minutes");
  return minutes;
}

function normalizeDiskSizeGb(value) {
  if (value === null || value === "") return null;
  const sizeGb = Number(value);
  if (!Number.isSafeInteger(sizeGb) || sizeGb < 10 || sizeGb > 4096) throw httpError(400, "invalid_machine_disk_size_gb");
  return sizeGb;
}

module.exports = {
  CONFIG_VERSION,
  createMachineConfigurationService,
  normalizeDesiredConfiguration,
  normalizeStoredConfiguration,
  safeConfiguration,
};
