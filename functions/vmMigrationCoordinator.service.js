"use strict";

const {DEFAULT_BUCKET} = require("./backendConfig");
const {httpError} = require("./backendUtils.helpers");
const {vmMigrationFenceRef} = require("./vmMigrationFence.helpers");
const {identify, observeVmMigration} = require("./vmMigrationPreflight.service");
const {covers, resolveMigrationPrefix} = require("./vmMigrationStorageScope.helpers");

const DRAIN_AFTER_FREEZE = new Set([
  "legacy_stop_requires_reconciliation", "legacy_sessions_require_quiesce", "background_runs_require_drain",
  "legacy_compute_operations_require_reconciliation", "legacy_upload_issuance_unresolved",
  "legacy_upload_sessions_require_drain",
]);
const ALIAS_LIMIT = 500;

function storageFenceRef(db, scope, ownerUid) {
  return db.collection("vmMigrationStorageFences_v2").doc(scope.bucket)
      .collection("owners").doc(ownerUid).collection("prefixes").doc(scope.workspaceKey);
}

function referencesPrefix(data, scope, defaultBucket) {
  const bucket = data.bucket || data.workspaceStorageBucket || defaultBucket;
  const pointers = [
    [bucket, data.storagePrefix], [data.workspaceStorageBucket || bucket, data.workspaceStoragePrefix],
    [data.homePolicy?.bucket || bucket, data.homePolicy?.storagePrefix],
  ];
  return pointers.some(([name, prefix]) => name === scope.bucket && typeof prefix === "string" &&
    (covers(scope.prefix, prefix) || covers(prefix, scope.prefix)));
}

function createVmMigrationCoordinator({db, authorize = async () => false, defaultBucket = DEFAULT_BUCKET, now = Date.now}) {
  function refs(input) {
    const workspaceId = identify(input.workspaceId);
    identify(input.ownerUid);
    const operationId = identify(input.operationId);
    const operation = db.collection("vmMigrationOperations_v2").doc(workspaceId).collection("operations").doc(operationId);
    return {operation, fence: vmMigrationFenceRef(db, workspaceId), source: db.collection("workspaces").doc(workspaceId)};
  }
  function status(record) {
    return {workspaceId: record.workspaceId, operationId: record.operationId, phase: record.phase,
      sourceGeneration: record.sourceGeneration, reservedAtMs: record.reservedAtMs, releasedAtMs: record.releasedAtMs ?? null,
      readyForCutover: false};
  }
  function requireOwner(record, input) {
    if (record.ownerUid !== input.ownerUid) throw httpError(404, "vm_migration_operation_not_found");
  }
  async function getStatus(input) {
    const snapshot = await refs(input).operation.get();
    if (!snapshot.exists) throw httpError(404, "vm_migration_operation_not_found");
    const record = snapshot.data();
    requireOwner(record, input);
    return status(record);
  }
  async function reserve(input) {
    const {operation, fence} = refs(input);
    if (!/^[a-f0-9]{64}$/.test(input.observationSha256 || "")) throw httpError(400, "vm_migration_observation_invalid");
    if (!await authorize(input, "reserve")) throw httpError(409, "vm_migration_fence_rollout_unverified");
    return db.runTransaction(async transaction => {
      const previous = await transaction.get(operation);
      if (previous.exists) {
        const record = previous.data();
        requireOwner(record, input);
        if (record.observationSha256 !== input.observationSha256) throw httpError(409, "vm_migration_operation_conflict");
        return status(record);
      }
      const observation = await observeVmMigration(transaction, {db, workspaceId: input.workspaceId, ownerUid: input.ownerUid, now});
      if (observation.observationSha256 !== input.observationSha256) throw httpError(409, "vm_migration_observation_stale");
      if (observation.blockers.some(blocker => !DRAIN_AFTER_FREEZE.has(blocker))) throw httpError(409, "vm_migration_source_blocked");
      const scope = resolveMigrationPrefix(observation.workspace, input.ownerUid, defaultBucket);
      const prefixFence = storageFenceRef(db, scope, input.ownerUid);
      const [existingPrefixFence, candidates] = await Promise.all([
        transaction.get(prefixFence),
        transaction.get(db.collection("workspaces").where("ownerUid", "==", input.ownerUid).limit(ALIAS_LIMIT + 1)),
      ]);
      if (existingPrefixFence.exists || candidates.size > ALIAS_LIMIT || candidates.docs.some(doc =>
        doc.id !== input.workspaceId && referencesPrefix(doc.data(), scope, defaultBucket))) {
        throw httpError(409, "vm_migration_storage_prefix_conflict");
      }
      const identity = {workspaceId: input.workspaceId, ownerUid: input.ownerUid, operationId: input.operationId};
      const record = {...identity, phase: "reserved", scope, sourceGeneration: observation.sourceGeneration,
        observationSha256: observation.observationSha256, reservedAtMs: now()};
      transaction.create(operation, record);
      transaction.create(fence, identity);
      transaction.create(prefixFence, identity);
      return status(record);
    });
  }
  async function abort(input) {
    const {operation, fence, source} = refs(input);
    if (!await authorize(input, "abort")) throw httpError(409, "vm_migration_fence_rollout_unverified");
    return db.runTransaction(async transaction => {
      const previous = await transaction.get(operation);
      if (!previous.exists) throw httpError(404, "vm_migration_operation_not_found");
      const record = previous.data();
      requireOwner(record, input);
      if (record.phase === "aborted") return status(record);
      if (record.phase !== "reserved") throw httpError(409, "vm_migration_abort_phase_invalid");
      const prefixFence = storageFenceRef(db, record.scope, input.ownerUid);
      const [workspace, workspaceFence, prefix, destination] = await Promise.all([
        transaction.get(source), transaction.get(fence), transaction.get(prefixFence),
        transaction.get(db.collection("vmRuntimes_v2").doc(input.workspaceId)),
      ]);
      const ownsFence = snapshot => snapshot.exists && ["workspaceId", "operationId", "ownerUid"]
          .every(key => snapshot.get(key) === input[key]);
      const data = workspace.data() || {};
      const generation = Number.isSafeInteger(data.agentRuntimeGeneration) ? data.agentRuntimeGeneration : null;
      if (!workspace.exists || workspace.get("ownerUid") !== input.ownerUid || destination.exists ||
          !ownsFence(workspaceFence) || !ownsFence(prefix) ||
          data.deleted === true || [data.status, data.lifecycle].some(state => ["deleting", "deleted"].includes(state)) ||
          generation !== record.sourceGeneration || [data.runtimeProvider, data.runtimeProviderDescriptor]
              .some(provider => provider && provider.backend !== "cloud-run") ||
          JSON.stringify(resolveMigrationPrefix(data, input.ownerUid, defaultBucket)) !== JSON.stringify(record.scope)) {
        throw httpError(409, "vm_migration_authority_changed");
      }
      const update = {phase: "aborted", releasedAtMs: now()};
      transaction.update(operation, update);
      transaction.delete(fence);
      transaction.delete(prefixFence);
      return status({...record, ...update});
    });
  }
  return {getStatus, reserve, abort};
}

module.exports = {createVmMigrationCoordinator};
