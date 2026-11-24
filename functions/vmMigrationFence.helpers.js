"use strict";

const {httpError} = require("./backendUtils.helpers");

const FENCE_COLLECTION = "vmMigrationFences_v2";
const FENCE_ERROR = "workspace_vm_migration_active";

function vmMigrationFenceRef(db, workspaceId) {
  return db.collection(FENCE_COLLECTION).doc(workspaceId);
}

function legacySharedStorageClaims(db, workspaceId) {
  return db.collection("vmLegacySharedStorage_v2").doc(workspaceId).collection("pending");
}

async function hasVmMigrationFence(transaction, db, workspaceId) {
  return (await transaction.get(vmMigrationFenceRef(db, workspaceId))).exists;
}

async function assertVmMigrationAdmission(transaction, db, workspaceId) {
  if (await hasVmMigrationFence(transaction, db, workspaceId)) throw httpError(409, FENCE_ERROR);
}

module.exports = {FENCE_ERROR, vmMigrationFenceRef, hasVmMigrationFence, assertVmMigrationAdmission, legacySharedStorageClaims};
