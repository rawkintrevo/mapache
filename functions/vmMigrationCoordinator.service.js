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
  "legacy_shared_storage_iam_unresolved",
  "legacy_storage_recovery_reservation_unresolved", "legacy_storage_recovery_write_unresolved",
  "legacy_runtime_schedule_lease_unresolved",
]);
const ALIAS_LIMIT = 500;
const DIGEST = /^[a-f0-9]{64}$/;

function ownsFence(snapshot, identity) {
  return snapshot.exists && ["workspaceId", "operationId", "ownerUid"].every(key => snapshot.get(key) === identity[key]);
}

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

function createVmMigrationCoordinator({
  db, authorize = async () => false, inspectCompute, inspectStorage, defaultBucket = DEFAULT_BUCKET, now = Date.now,
}) {
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
      quiescedAtMs: record.quiesce?.confirmedAtMs ?? null,
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
    if (!DIGEST.test(input.observationSha256 || "")) throw httpError(400, "vm_migration_observation_invalid");
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
  async function readQuiesceState(transaction, input, {operation, fence}) {
    const previous = await transaction.get(operation);
    if (!previous.exists) throw httpError(404, "vm_migration_operation_not_found");
    const record = previous.data();
    requireOwner(record, input);
    if (record.phase === "quiesced") return {record};
    if (record.phase !== "reserved") throw httpError(409, "vm_migration_quiesce_phase_invalid");
    const observation = await observeVmMigration(transaction, {db, workspaceId: input.workspaceId, ownerUid: input.ownerUid, now});
    const scope = resolveMigrationPrefix(observation.workspace, input.ownerUid, defaultBucket);
    const prefixFence = storageFenceRef(db, scope, input.ownerUid);
    const [workspaceFence, prefix, candidates] = await Promise.all([
      transaction.get(fence),
      transaction.get(prefixFence),
      transaction.get(db.collection("workspaces").where("ownerUid", "==", input.ownerUid).limit(ALIAS_LIMIT + 1)),
    ]);
    if (!ownsFence(workspaceFence, input) || !ownsFence(prefix, input) ||
        observation.sourceGeneration !== record.sourceGeneration || JSON.stringify(scope) !== JSON.stringify(record.scope)) {
      throw httpError(409, "vm_migration_authority_changed");
    }
    if (observation.blockers.some(blocker => blocker !== "migration_fence_already_exists")) {
      throw httpError(409, "vm_migration_writers_not_drained");
    }
    if (candidates.size > ALIAS_LIMIT || candidates.docs.some(doc => doc.id !== input.workspaceId &&
        referencesPrefix(doc.data(), scope, defaultBucket))) throw httpError(409, "vm_migration_storage_prefix_conflict");
    const stamps = [previous, workspaceFence, prefix].map(({updateTime}) => [updateTime.seconds, updateTime.nanoseconds]);
    return {record, observation, authorityStamps: JSON.stringify(stamps)};
  }

  async function confirmQuiesced(input) {
    const references = refs(input);
    if (!inspectCompute || !inspectStorage || !await authorize(input, "quiesce")) {
      throw httpError(409, "vm_migration_quiesce_unverified");
    }
    const before = await db.runTransaction(transaction => readQuiesceState(transaction, input, references), {readOnly: true});
    if (before.record.phase === "quiesced") return status(before.record);
    const {workspace, sessions} = before.observation;
    const identity = {workspace, workspaceId: input.workspaceId, ownerUid: input.ownerUid};
    const [compute, storage] = await Promise.all([inspectCompute(sessions, identity), inspectStorage({...identity, sessions})]);
    if (compute?.recordedComputeClear !== true || compute.discovery?.scannedRegionsClear !== true ||
        !Array.isArray(compute.blockers) || compute.blockers.length || !DIGEST.test(compute.providerObservationSha256 || "") ||
        !DIGEST.test(compute.discovery.evidenceSha256 || "")) throw httpError(409, "vm_migration_compute_not_quiesced");
    if (storage?.stable !== true || !Array.isArray(storage.blockers) || storage.blockers.length ||
        !DIGEST.test(storage.firstSha256 || "") ||
        storage.firstSha256 !== storage.secondSha256) throw httpError(409, "vm_migration_storage_not_quiesced");

    return db.runTransaction(async transaction => {
      const current = await readQuiesceState(transaction, input, references);
      if (current.record.phase === "quiesced") return status(current.record);
      if (before.observation.observationSha256 !== current.observation.observationSha256 ||
          before.authorityStamps !== current.authorityStamps) throw httpError(409, "vm_migration_quiesce_observation_stale");
      const update = {phase: "quiesced", quiesce: {confirmedAtMs: now(), observationSha256: current.observation.observationSha256,
        providerSha256: compute.providerObservationSha256, discoverySha256: compute.discovery.evidenceSha256,
        storageSha256: storage.secondSha256}};
      transaction.update(references.operation, update);
      return status({...current.record, ...update});
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
      if (!["reserved", "quiesced"].includes(record.phase)) throw httpError(409, "vm_migration_abort_phase_invalid");
      const prefixFence = storageFenceRef(db, record.scope, input.ownerUid);
      const [workspace, workspaceFence, prefix, destination] = await Promise.all([
        transaction.get(source), transaction.get(fence), transaction.get(prefixFence),
        transaction.get(db.collection("vmRuntimes_v2").doc(input.workspaceId)),
      ]);
      const data = workspace.data() || {};
      const generation = Number.isSafeInteger(data.agentRuntimeGeneration) ? data.agentRuntimeGeneration : null;
      if (!workspace.exists || workspace.get("ownerUid") !== input.ownerUid || destination.exists ||
          !ownsFence(workspaceFence, input) || !ownsFence(prefix, input) ||
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
  return {getStatus, reserve, confirmQuiesced, abort};
}

module.exports = {createVmMigrationCoordinator};
