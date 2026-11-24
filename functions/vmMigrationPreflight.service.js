"use strict";

const {createHash} = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const {isWorkspaceStorageMigrationActive} = require("./runtimeReservation.helpers");
const {vmMigrationFenceRef} = require("./vmMigrationFence.helpers");
const {vmLegacyUploadRef} = require("./vmLegacyUploadAdmission.service");

const SESSION_LIMIT = 500;
const RUN_LIMIT = 100;
const ACTIVE_RUNS = ["queued", "provisioning", "running", "stopping"];
const STOPPED_SESSION_STATES = new Set(["stopped", "inactive", "needs_image", "needs_service", "provision_failed", "update_failed"]);
const FAILED_STOP_STATES = new Set(["stop_failed", "delete_failed", "cleanup_pending"]);
const normalize = value => typeof value === "string" ? value.trim().toLowerCase() : "";

function identify(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw httpError(400, "vm_migration_identity_invalid");
  return value;
}

function classify(workspace, legacySessions, runs, existingVm) {
  const blockers = [];
  const lifecycleStates = [workspace.lifecycle, workspace.status].map(normalize);
  if (workspace.deleted === true || lifecycleStates.some(state => ["deleting", "deleted"].includes(state))) {
    blockers.push("workspace_unavailable");
  }
  const source = typeof workspace.source === "string" ? workspace.source : workspace.source?.type;
  if (source === "ssh" || workspace.runtimeProvider?.backend === "ssh" ||
      legacySessions.some(session => session.terminalKind === "ssh" || session.runtimeProvider?.backend === "ssh")) {
    blockers.push("ssh_source_unsupported");
  }
  if (workspace.imageKey === "pi-n64" || legacySessions.some(session => session.imageKey === "pi-n64")) {
    blockers.push("n64_source_unsupported");
  }
  if ([workspace.runtimeProvider, workspace.runtimeProviderDescriptor].some(provider => provider && provider.backend !== "cloud-run")) {
    blockers.push("source_backend_not_legacy");
  }
  if (existingVm) blockers.push("destination_registry_exists");
  if (isWorkspaceStorageMigrationActive(workspace)) blockers.push("legacy_storage_operation_active");
  if (legacySessions.some(session => session.ownerUid && session.ownerUid !== workspace.ownerUid) ||
      runs.some(run => run.ownerUid !== workspace.ownerUid)) blockers.push("legacy_writer_owner_mismatch");
  const failures = legacySessions.filter(session => FAILED_STOP_STATES.has(normalize(session.status)));
  const active = legacySessions.filter(session => !STOPPED_SESSION_STATES.has(normalize(session.status)) &&
    !FAILED_STOP_STATES.has(normalize(session.status)));
  if (failures.length) blockers.push("legacy_stop_requires_reconciliation");
  if (active.length || workspace.agentRuntimeBootInstanceId ||
      ["starting", "running", "stopping"].includes(normalize(workspace.agentRuntimeState))) {
    blockers.push("legacy_sessions_require_quiesce");
  }
  if (runs.length) blockers.push("background_runs_require_drain");
  if (legacySessions.some(session => ["queued", "running"].includes(normalize(session.resizeOperationState)) ||
      ["queued", "pending", "running"].includes(normalize(session.provisioningState)))) {
    blockers.push("legacy_compute_operations_require_reconciliation");
  }
  return {blockers, counts: {observedSessions: legacySessions.length, possiblyActiveSessions: active.length,
    failedStops: failures.length, observedQueuedOrActiveRuns: runs.length}};
}

async function observeVmMigration(transaction, {db, workspaceId, ownerUid, now = Date.now}) {
  identify(workspaceId);
  identify(ownerUid);
  const workspaceRef = db.collection("workspaces").doc(workspaceId);
  const destinationRef = db.collection("vmRuntimes_v2").doc(workspaceId);
  const uploadRef = vmLegacyUploadRef(db, workspaceId);
  const pendingUploads = uploadRef.collection("pending").limit(1);
  const sessions = workspaceRef.collection("sessions").limit(SESSION_LIMIT + 1);
  const runs = db.collection("automationRuns").where("workspaceId", "==", workspaceId)
      .where("status", "in", ACTIVE_RUNS).limit(RUN_LIMIT + 1);
  const workspace = await transaction.get(workspaceRef);
  if (!workspace.exists || workspace.get("ownerUid") !== ownerUid) throw httpError(404, "vm_migration_source_not_found");
  const [destination, fence, sessionList, runList, uploads, pending] = await Promise.all([
    transaction.get(destinationRef), transaction.get(vmMigrationFenceRef(db, workspaceId)),
    transaction.get(sessions), transaction.get(runs), transaction.get(uploadRef), transaction.get(pendingUploads),
  ]);
  const sessionRecords = sessionList.docs.slice(0, SESSION_LIMIT);
  const runRecords = runList.docs.slice(0, RUN_LIMIT);
  const result = classify(workspace.data(), sessionRecords.map(s => s.data()), runRecords.map(s => s.data()), destination.exists);
  if (fence.exists) result.blockers.push("migration_fence_already_exists");
  if (pending.size) result.blockers.push("legacy_upload_issuance_unresolved");
  const drainUntilMs = uploads.get("drainUntilMs");
  if (uploads.exists && (!Number.isSafeInteger(drainUntilMs) || drainUntilMs > now())) {
    result.blockers.push("legacy_upload_sessions_require_drain");
  }
  const truncated = sessionList.size > SESSION_LIMIT || runList.size > RUN_LIMIT;
  if (truncated) result.blockers.push("legacy_writer_inventory_truncated");
  const observedSourceGeneration = workspace.get("agentRuntimeGeneration");
  const stamp = snapshot => [snapshot.ref.path, snapshot.updateTime?.seconds ?? null, snapshot.updateTime?.nanoseconds ?? null];
  const evidence = [workspace, destination, fence, uploads, ...pending.docs, ...sessionRecords, ...runRecords].map(stamp)
      .sort(([a], [b]) => a.localeCompare(b));
  return {...result, workspace: workspace.data(), workspaceId,
    sessions: sessionRecords.map(snapshot => ({...snapshot.data(), id: snapshot.id || snapshot.ref.path.split("/").at(-1)})),
    // This fingerprint binds the observed records, not Cloud Run or Storage.
    observationSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    sourceGeneration: Number.isSafeInteger(observedSourceGeneration) ? observedSourceGeneration : null};
}

function createVmMigrationPreflight({db, now = Date.now, inspectCompute, inspectStorage}) {
  return async ({workspaceId, ownerUid, checkCompute = false, checkStorage = false}) => {
    const read = () => db.runTransaction(transaction => observeVmMigration(transaction, {db, workspaceId, ownerUid, now}), {readOnly: true});
    const {workspace, sessions, ...result} = await read();
    let compute;
    let storage;
    if (!result.blockers.includes("legacy_writer_inventory_truncated")) {
      [compute, storage] = await Promise.all([
        checkCompute && inspectCompute ? inspectCompute(sessions, {workspace, workspaceId, ownerUid}) : undefined,
        checkStorage && inspectStorage ? inspectStorage({workspace, workspaceId, ownerUid, sessions}) : undefined,
      ]);
      if ((compute || storage) && (await read()).observationSha256 !== result.observationSha256) {
        if (compute) compute = {...compute, recordedComputeClear: false,
          ...(compute.discovery ? {discovery: {...compute.discovery, scannedRegionsClear: false}} : {}),
          blockers: [...compute.blockers, "legacy_compute_source_changed"]};
        if (storage) storage = {...storage, stable: false, blockers: [...storage.blockers, "legacy_storage_source_changed"]};
      }
    }
    return {...result, ...(compute ? {compute} : {}), ...(storage ? {storage} : {}), readOnly: true,
      readyForFreeze: false, readyForCutover: false,
      blockers: [...result.blockers, ...(compute?.blockers || []), ...(storage?.blockers || []), "legacy_admission_fence_unverified",
        "live_compute_and_storage_authority_unverified", "untracked_legacy_upload_sessions_unverified"]};
  };
}

module.exports = {createVmMigrationPreflight, observeVmMigration, identify};
