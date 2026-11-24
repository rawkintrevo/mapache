"use strict";

const {randomUUID} = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const {assertVmMigrationAdmission} = require("./vmMigrationFence.helpers");

// GCS resumable sessions last one week from initiation. Start the hold
// after the provider responds and add margin for clock skew.
const UPLOAD_HOLD_MS = 7 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000;

function vmLegacyUploadRef(db, workspaceId) {
  return db.collection("vmLegacyUploads_v2").doc(workspaceId);
}

async function mintLegacyUpload({db, uid, workspaceId, validateWorkspace, mint, now = Date.now}) {
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  const uploadRef = vmLegacyUploadRef(db, workspaceId);
  const pendingRef = uploadRef.collection("pending").doc(randomUUID());
  await db.runTransaction(async transaction => {
    const workspace = await transaction.get(workspaceRef);
    if (!workspace.exists || workspace.get("ownerUid") !== uid) throw httpError(404, "workspace_not_found");
    const data = workspace.data();
    if (data.deleted === true || [data.status, data.lifecycle].some(state => ["deleting", "deleted"].includes(state))) {
      throw httpError(409, "workspace_unavailable");
    }
    await assertVmMigrationAdmission(transaction, db, workspaceId);
    validateWorkspace(data);
    transaction.create(pendingRef, {startedAtMs: now()});
  });
  // Keep the pending record on failure. A network error cannot distinguish
  // between pre-request failure and an accepted but unobserved GCS session.
  const url = await mint();
  if (!url) throw httpError(502, "workspace_upload_session_unavailable");
  const drainUntilMs = now() + UPLOAD_HOLD_MS;
  await db.runTransaction(async transaction => {
    const [pending, summary] = await Promise.all([transaction.get(pendingRef), transaction.get(uploadRef)]);
    if (!pending.exists) throw httpError(409, "workspace_upload_reservation_missing");
    const previous = summary.get("drainUntilMs");
    transaction.set(uploadRef, {drainUntilMs: Math.max(Number.isSafeInteger(previous) ? previous : 0, drainUntilMs)}, {merge: true});
    transaction.delete(pendingRef);
    // URL is intentionally never persisted.
  });
  return url;
}

module.exports = {mintLegacyUpload, vmLegacyUploadRef, UPLOAD_HOLD_MS};
