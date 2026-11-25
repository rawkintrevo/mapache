"use strict";

const {createHash} = require("node:crypto");
const {DEFAULT_BUCKET} = require("./backendConfig");
const {httpError} = require("./backendUtils.helpers");
const {vmMigrationFenceRef} = require("./vmMigrationFence.helpers");
const {identify, observeVmMigration} = require("./vmMigrationPreflight.service");
const {covers, resolveMigrationPrefix} = require("./vmMigrationStorageScope.helpers");
const {prepareStorageCapture, MAX_CAPTURE_CHUNKS} = require("./vmMigrationStorageObservation.service");
const {isMainRuntime} = require("./runtimePaths.helpers");
const {sessionHomePolicyMetadata} = require("./sessionCreation.service");
const {createRuntimeDescriptor, COMPUTE_ENGINE_BACKEND} = require("./runtimeProvider.helpers");
const {reserveValidationRuntime} = require("./vmMigrationValidationBoot.service");
const {DESTINATION_AUTHORITY, cutoverReview, validateDestinationRuntimeEvidence} = require("./vmMigrationCutover.service");
const {vmMigrationSourceAuditRef, requireReadyVmMigrationSourceAudit} = require("./vmMigrationSourceAudit.helpers");

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
const DISK_ID = /^[1-9][0-9]{0,19}$/;
const REVERSE_IMPORT_FORMAT = "mapache-reverse-import-v1";
const RUNNER_IMAGE = /^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/;
const CAPTURE_COMPONENTS = new Set(["agent", "browser", "home", "workspace"]);
const STATUS_ACTIONS = Object.freeze({
  reserved: "confirm-quiesced",
  quiesced: "capture-prefix",
  "prefix-captured": "verify-disk-import",
  "disk-import-verified": "review-cutover-gates",
  "authority-switched": "reconcile-source",
  "rollback-draining": "complete-rollback",
  "rolled-back": null,
  aborted: null,
});
const versionStamp = ({updateTime}) => [updateTime.seconds, updateTime.nanoseconds];

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

function normalizeDiskDestination(input) {
  const {zone, generation, operationId} = input.destination || {};
  const region = typeof zone === "string" ? /^([a-z]+-[a-z]+[0-9]+)-[a-z]$/.exec(zone)?.[1] : null;
  if (!region || !Number.isSafeInteger(generation) || generation < 1) throw httpError(400, "vm_migration_disk_destination_invalid");
  identify(operationId);
  return {zone, region, generation, operationId};
}

function verifyDiskReceipt(evidence, record) {
  const destination = record.importDestination;
  const receipt = evidence?.receipt;
  const capture = receipt?.prefixCapture;
  if (evidence?.diskId !== destination.diskId || receipt?.schemaVersion !== 1 ||
      !DIGEST.test(receipt.configSha256 || "") || !DIGEST.test(receipt.sourcePlanSha256 || "") ||
      !Number.isSafeInteger(receipt.directoriesPublished) || receipt.directoriesPublished < 1 || receipt.directoriesPublished > 5 ||
      !Number.isSafeInteger(receipt.selectedEntries) || receipt.selectedEntries < receipt.directoriesPublished ||
      capture?.operationId !== record.operationId || capture.sourceGeneration !== record.sourceGeneration ||
      capture.sha256 !== record.prefixCapture.sha256 || !Array.isArray(capture.components) ||
      !capture.components.length || capture.components.length > CAPTURE_COMPONENTS.size ||
      capture.components.some((name, index) => !CAPTURE_COMPONENTS.has(name) || (index > 0 && capture.components[index - 1] >= name)) ||
      ["workspaceId", "ownerUid"].some(key => receipt.destination?.[key] !== record[key]) ||
      ["operationId", "generation", "diskName"].some(key => receipt.destination?.[key] !== destination[key])) {
    throw httpError(409, "vm_migration_disk_receipt_invalid");
  }
  const canonical = {diskId: evidence.diskId, workspaceId: record.workspaceId, ownerUid: record.ownerUid,
    generation: destination.generation, operationId: destination.operationId, diskName: destination.diskName, zone: destination.zone,
    captureSha256: capture.sha256, sourceGeneration: capture.sourceGeneration, components: capture.components,
    configSha256: receipt.configSha256, sourcePlanSha256: receipt.sourcePlanSha256,
    directoriesPublished: receipt.directoriesPublished, selectedEntries: receipt.selectedEntries};
  return {receiptSha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    sourcePlanSha256: receipt.sourcePlanSha256, components: capture.components, selectedEntries: receipt.selectedEntries};
}

function verifyReverseImportReceipt(receipt, record) {
  const destinationGeneration = record.importDestination?.generation;
  if (!receipt || receipt.version !== 1 || receipt.state !== "verified" ||
      receipt.format !== REVERSE_IMPORT_FORMAT || receipt.operationId !== record.operationId ||
      receipt.sourceGeneration !== record.sourceGeneration || receipt.destinationGeneration !== destinationGeneration ||
      !DIGEST.test(receipt.sha256 || "") || !DIGEST.test(receipt.sourceObservationSha256 || "")) {
    throw httpError(409, "vm_migration_reverse_import_unverified");
  }
  return {
    version: 1,
    state: "verified",
    format: REVERSE_IMPORT_FORMAT,
    operationId: record.operationId,
    sourceGeneration: record.sourceGeneration,
    destinationGeneration,
    sha256: receipt.sha256,
    sourceObservationSha256: receipt.sourceObservationSha256,
  };
}

function verifyDestinationRollbackEvidence(evidence, record) {
  const destination = record.importDestination;
  const runtime = evidence?.runtime;
  const registry = evidence?.registry;
  const session = evidence?.session;
  const route = evidence?.route;
  if (!destination || evidence?.schemaVersion !== 1 || evidence.workspaceId !== record.workspaceId ||
      evidence.ownerUid !== record.ownerUid || evidence.migrationOperationId !== record.operationId ||
      evidence.destinationGeneration !== destination.generation || evidence.diskId !== destination.diskId ||
      evidence.diskName !== destination.diskName || runtime?.state !== "stopped" ||
      runtime.instanceAbsent !== true || runtime.disk?.diskId !== destination.diskId ||
      runtime.disk?.diskName !== destination.diskName || runtime.disk?.attached !== false ||
      registry?.apiEnabled !== false || !["stopping", "stopped"].includes(registry.state) ||
      registry.generation !== destination.generation || registry.currentSessionId !== evidence.sessionId ||
      session?.state !== registry.state || session.generation !== destination.generation ||
      route?.enabled !== false || route.generation !== destination.generation ||
      route.sessionId !== evidence.sessionId) {
    throw httpError(409, "vm_migration_destination_writers_not_stopped");
  }
  return {
    version: 1,
    state: "stopped",
    workspaceId: record.workspaceId,
    ownerUid: record.ownerUid,
    migrationOperationId: record.operationId,
    destinationGeneration: destination.generation,
    diskId: destination.diskId,
    diskName: destination.diskName,
    sessionId: evidence.sessionId,
    instanceAbsent: true,
    diskAttached: false,
  };
}

function createVmMigrationCoordinator({
  db, authorize = async () => false, inspectCompute, inspectStorage, inspectDestinationDisk, readDiskImportEvidence,
  inspectDestinationRuntime, inspectDestinationRollback, deleteImportedDisk, ensureValidationClone, startValidationVm, deleteValidationResources,
  defaultBucket = DEFAULT_BUCKET, now = Date.now, requireSourceAudit = false,
}) {
  function refs(input) {
    const workspaceId = identify(input.workspaceId);
    identify(input.ownerUid);
    const operationId = identify(input.operationId);
    const operation = db.collection("vmMigrationOperations_v2").doc(workspaceId).collection("operations").doc(operationId);
    return {operation, fence: vmMigrationFenceRef(db, workspaceId), source: db.collection("workspaces").doc(workspaceId)};
  }
  function status(record) {
    const validation = record.validation || {};
    const validationAction = record.phase === "disk-import-verified" && !validation.cleanedAtMs ?
      (validation.instanceId ? "cleanup-validation-boot" : validation.cloneDiskId ? "start-validation-boot" :
        validation.reservedAtMs ? "prepare-validation-clone" : "reserve-validation-boot") : null;
    const destinationCleanupAction = record.phase === "disk-import-verified" && validation.cleanedAtMs !== undefined &&
      record.destinationCleanup?.cleanedAtMs === undefined ? "cleanup-imported-disk" : null;
    const sourceReconciliationAction = record.phase === "authority-switched" && !record.sourceReconciliation ?
      "reconcile-source" : null;
    const phaseAction = record.phase === "authority-switched" ? sourceReconciliationAction : STATUS_ACTIONS[record.phase] || null;
    const nextAction = destinationCleanupAction || validationAction || phaseAction;
    const blockers = Array.isArray(record.drainBlockers) ? [...record.drainBlockers] : [];
    let recoveryAction = "Review the migration status and retain the source before retrying.";
    if (record.phase === "aborted") recoveryAction = "Start a new migration after a fresh read-only preflight.";
    else if (record.phase === "rollback-draining") {
      recoveryAction = "Keep destination access disabled, confirm the exact VM is stopped and reverse-import the current destination state before completing rollback.";
    }
    else if (record.phase === "rolled-back") {
      recoveryAction = "Legacy authority is restored; retain the detached VM disk and reverse-import receipt through the rollback window.";
    }
    else if (blockers.length) recoveryAction = "Drain the listed legacy writers, then retry the quiesce action.";
    else if (record.phase === "disk-import-verified" && validation.cleanedAtMs === undefined) {
      recoveryAction = "Complete validation boot and ID-checked cleanup before cutover review.";
    } else if (destinationCleanupAction) {
      recoveryAction = "Delete the exact imported disk through the ownership-checked cleanup action before abort or cutover review.";
    } else if (record.sourceReconciliation) {
      recoveryAction = "Retain the legacy source through the rollback window; do not delete it from this migration action.";
    } else if (nextAction) recoveryAction = `Retry the ${nextAction} action after rechecking the recorded source evidence.`;
    return {workspaceId: record.workspaceId, operationId: record.operationId, phase: record.phase,
      sourceGeneration: record.sourceGeneration, reservedAtMs: record.reservedAtMs, releasedAtMs: record.releasedAtMs ?? null,
      sourceAuditSha256: record.sourceAuditSha256 ?? null,
      quiescedAtMs: record.quiesce?.confirmedAtMs ?? null,
      downtimeStartedAtMs: record.quiesce?.confirmedAtMs ?? null,
      prefixCapturedAtMs: record.prefixCapture?.confirmedAtMs ?? null,
      prefixCapturedObjects: record.prefixCapture?.objectCount ?? null,
      diskImportVerifiedAtMs: record.diskImport?.verifiedAtMs ?? null,
      diskImportedComponents: record.diskImport?.components ?? null,
      validationReservedAtMs: record.validation?.reservedAtMs ?? null,
      validationCloneVerifiedAtMs: record.validation?.cloneVerifiedAtMs ?? null,
      validationBootRequestedAtMs: record.validation?.bootRequestedAtMs ?? null,
      validationInstanceStartedAtMs: record.validation?.instanceStartedAtMs ?? null,
      validationCleanedAtMs: record.validation?.cleanedAtMs ?? null,
      destinationDiskCleanedAtMs: record.destinationCleanup?.cleanedAtMs ?? null,
      authoritySwitchedAtMs: record.authoritySwitch?.switchedAtMs ?? null,
      sourceReconciledAtMs: record.sourceReconciliation?.reconciledAtMs ?? null,
      rollbackStartedAtMs: record.rollback?.startedAtMs ?? null,
      rollbackCompletedAtMs: record.rollback?.completedAtMs ?? null,
      rollbackState: record.rollback?.state ?? null,
      authority: ["authority-switched", "rollback-draining"].includes(record.phase) ? "destination" : "legacy",
      nextAction, blockers, recoveryAction, sourceRetained: true,
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
      const sourceAudit = requireSourceAudit ? await transaction.get(vmMigrationSourceAuditRef(db, input.workspaceId)) : null;
      if (requireSourceAudit) requireReadyVmMigrationSourceAudit(sourceAudit?.data(), {
        workspaceId: input.workspaceId, ownerUid: input.ownerUid, sourceGeneration: observation.sourceGeneration,
        observationSha256: observation.observationSha256, sourceObservationSha256: observation.sourceObservationSha256, scope,
      });
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
        observationSha256: observation.observationSha256,
        ...(requireSourceAudit ? {sourceAuditSha256: sourceAudit.get("evidenceSha256")} : {}),
        drainBlockers: observation.blockers.filter(blocker => blocker !== "migration_fence_already_exists"), reservedAtMs: now()};
      transaction.create(operation, record);
      transaction.create(fence, identity);
      transaction.create(prefixFence, identity);
      return status(record);
    });
  }
  async function readFencedSource(transaction, input, {operation, fence}, {phases, completed, invalidPhase, allowedBlockers = []}) {
    const previous = await transaction.get(operation);
    if (!previous.exists) throw httpError(404, "vm_migration_operation_not_found");
    const record = previous.data();
    requireOwner(record, input);
    if (completed.includes(record.phase)) return {record};
    if (!phases.includes(record.phase)) throw httpError(409, invalidPhase);
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
    const allowed = new Set(allowedBlockers);
    if (observation.blockers.some(blocker => blocker !== "migration_fence_already_exists" && !allowed.has(blocker))) {
      throw httpError(409, "vm_migration_writers_not_drained");
    }
    if (candidates.size > ALIAS_LIMIT || candidates.docs.some(doc => doc.id !== input.workspaceId &&
        referencesPrefix(doc.data(), scope, defaultBucket))) throw httpError(409, "vm_migration_storage_prefix_conflict");
    const fenceVersions = JSON.stringify([workspaceFence, prefix].map(versionStamp));
    return {record, observation, fenceVersions, authorityStamps: JSON.stringify([versionStamp(previous), fenceVersions])};
  }

  async function readProviders(input, {workspace, sessions}, includeInventory = false) {
    const identity = {workspace, workspaceId: input.workspaceId, ownerUid: input.ownerUid};
    const [compute, storage] = await Promise.all([
      inspectCompute(sessions, identity), inspectStorage({...identity, sessions}, {includeInventory}),
    ]);
    if (compute?.recordedComputeClear !== true || compute.discovery?.scannedRegionsClear !== true ||
        !Array.isArray(compute.blockers) || compute.blockers.length || !DIGEST.test(compute.providerObservationSha256 || "") ||
        !DIGEST.test(compute.discovery.evidenceSha256 || "")) throw httpError(409, "vm_migration_compute_not_quiesced");
    if (storage?.stable !== true || !Array.isArray(storage.blockers) || storage.blockers.length ||
        !DIGEST.test(storage.firstSha256 || "") ||
        storage.firstSha256 !== storage.secondSha256) throw httpError(409, "vm_migration_storage_not_quiesced");
    return {providerSha256: compute.providerObservationSha256, discoverySha256: compute.discovery.evidenceSha256,
      storageSha256: storage.secondSha256, inventory: storage.inventory};
  }

  async function confirmQuiesced(input) {
    const references = refs(input);
    if (!inspectCompute || !inspectStorage || !await authorize(input, "quiesce")) {
      throw httpError(409, "vm_migration_quiesce_unverified");
    }
    const read = transaction => readFencedSource(transaction, input, references, {
      phases: ["reserved"], completed: ["quiesced", "prefix-captured", "disk-import-verified"],
      invalidPhase: "vm_migration_quiesce_phase_invalid",
    });
    const before = await db.runTransaction(read, {readOnly: true});
    if (!before.observation) return status(before.record);
    const {providerSha256, discoverySha256, storageSha256} = await readProviders(input, before.observation);
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (!current.observation) return status(current.record);
      if (before.observation.observationSha256 !== current.observation.observationSha256 ||
          before.authorityStamps !== current.authorityStamps) throw httpError(409, "vm_migration_quiesce_observation_stale");
      const update = {phase: "quiesced", drainBlockers: [], quiesce: {confirmedAtMs: now(), observationSha256: current.observation.observationSha256,
        sourceObservationSha256: current.observation.sourceObservationSha256 || current.observation.observationSha256,
        fenceVersions: current.fenceVersions, providerSha256, discoverySha256, storageSha256}};
      transaction.update(references.operation, update);
      return status({...current.record, ...update});
    });
  }

  async function capturePrefix(input) {
    const references = refs(input);
    if (!inspectCompute || !inspectStorage || !await authorize(input, "capture-prefix")) {
      throw httpError(409, "vm_migration_prefix_capture_unverified");
    }
    const read = transaction => readFencedSource(transaction, input, references, {
      phases: ["quiesced"], completed: ["prefix-captured", "disk-import-verified"], invalidPhase: "vm_migration_prefix_capture_phase_invalid",
    });
    const before = await db.runTransaction(read, {readOnly: true});
    if (!before.observation) return status(before.record);
    const {quiesce, scope} = before.record;
    if (!matchesQuiesce(before)) {
      throw httpError(409, "vm_migration_prefix_capture_source_changed");
    }
    const providers = await readProviders(input, before.observation, true);
    if (["providerSha256", "discoverySha256", "storageSha256"].some(key => providers[key] !== quiesce[key])) {
      throw httpError(409, "vm_migration_prefix_capture_provider_changed");
    }
    let prepared;
    try {
      prepared = prepareStorageCapture(scope, providers.inventory, quiesce.storageSha256);
    } catch (error) {
      throw httpError(409, error.message);
    }
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (!current.observation) return status(current.record);
      if (before.observation.observationSha256 !== current.observation.observationSha256 ||
          before.authorityStamps !== current.authorityStamps) throw httpError(409, "vm_migration_prefix_capture_stale");
      const {sha256, chunks, objectCount} = prepared;
      const inventory = references.operation.collection("prefixInventory");
      for (const [index, rowsJson] of chunks.entries()) {
        transaction.create(inventory.doc(String(index)), {rowsJson});
      }
      const update = {phase: "prefix-captured",
        prefixCapture: {version: 1, confirmedAtMs: now(), sha256, chunkCount: chunks.length, objectCount}};
      transaction.update(references.operation, update);
      return status({...current.record, ...update});
    });
  }

  function matchesQuiesce({record, observation, fenceVersions}) {
    return (record.quiesce?.sourceObservationSha256 || record.quiesce?.observationSha256) ===
      (observation.sourceObservationSha256 || observation.observationSha256) &&
      record.quiesce.fenceVersions === fenceVersions;
  }

  async function inspectDisk(input, destination) {
    const {workspaceId, ownerUid} = input;
    const {zone, region, generation, operationId} = destination;
    const descriptor = createRuntimeDescriptor({backend: COMPUTE_ENGINE_BACKEND, workspaceId, ownerUid, zone, region, generation});
    const disk = await inspectDestinationDisk(descriptor, {operationId});
    if (disk?.diskName !== descriptor.dataDiskName || disk.zone !== zone ||
        typeof disk.diskId !== "string" || !DISK_ID.test(disk.diskId)) throw httpError(409, "vm_migration_disk_unverified");
    return {diskId: disk.diskId, diskName: disk.diskName, lastAttachTimestamp: disk.lastAttachTimestamp ?? null};
  }

  async function readImportState(transaction, input, references, completed = []) {
    const current = await readFencedSource(transaction, input, references, {
      phases: ["prefix-captured"], completed, invalidPhase: "vm_migration_disk_import_phase_invalid",
    });
    if (current.observation) {
      const {prefixCapture, quiesce} = current.record;
      if (!matchesQuiesce(current)) throw httpError(409, "vm_migration_prefix_capture_source_changed");
      if (prefixCapture?.version !== 1 || !DIGEST.test(prefixCapture.sha256 || "") || prefixCapture.sha256 !== quiesce.storageSha256) {
        throw httpError(409, "legacy_storage_capture_invalid");
      }
    }
    return current;
  }

  async function registerImportDisk(input) {
    const references = refs(input);
    const destination = normalizeDiskDestination(input);
    if (!inspectDestinationDisk || !await authorize(input, "register-import-disk")) {
      throw httpError(409, "vm_migration_disk_import_unverified");
    }
    const read = transaction => readImportState(transaction, input, references);
    const before = await db.runTransaction(read, {readOnly: true});
    const {diskId, diskName} = await inspectDisk(input, destination);
    const importDestination = {...destination, diskId, diskName};
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (current.record.importDestination) {
        if (Object.keys(importDestination).some(key => current.record.importDestination[key] !== importDestination[key])) {
          throw httpError(409, "vm_migration_disk_destination_conflict");
        }
        return status(current.record);
      }
      if (before.observation.observationSha256 !== current.observation.observationSha256 ||
          before.authorityStamps !== current.authorityStamps) throw httpError(409, "vm_migration_disk_observation_stale");
      transaction.update(references.operation, {importDestination});
      return status({...current.record, importDestination});
    });
  }

  async function verifyDiskImport(input) {
    const references = refs(input);
    if (!inspectDestinationDisk || !readDiskImportEvidence || !await authorize(input, "verify-disk-import")) {
      throw httpError(409, "vm_migration_disk_import_unverified");
    }
    const read = transaction => readImportState(transaction, input, references, ["disk-import-verified"]);
    const before = await db.runTransaction(read, {readOnly: true});
    if (!before.observation) return status(before.record);
    const destination = before.record.importDestination;
    if (!destination) throw httpError(409, "vm_migration_disk_destination_unregistered");
    const capture = before.record.prefixCapture;
    const {workspaceId, ownerUid, operationId, sourceGeneration} = before.record;
    const evidence = await readDiskImportEvidence({workspaceId, ownerUid, destination,
      prefixCapture: {operationId, sourceGeneration, sha256: capture.sha256}});
    const verified = verifyDiskReceipt(evidence, before.record);
    const disk = await inspectDisk(input, destination);
    if (disk.diskId !== destination.diskId) throw httpError(409, "vm_migration_disk_identity_changed");
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (!current.observation) return status(current.record);
      if (before.observation.observationSha256 !== current.observation.observationSha256 ||
          before.authorityStamps !== current.authorityStamps) throw httpError(409, "vm_migration_disk_observation_stale");
      const update = {phase: "disk-import-verified", diskImport: {...verified, diskLastAttachTimestamp: disk.lastAttachTimestamp,
        verifiedAtMs: now()}};
      transaction.update(references.operation, update);
      return status({...current.record, ...update});
    });
  }

  async function readValidationState(transaction, input, references) {
    const current = await readFencedSource(transaction, input, references, {
      phases: ["disk-import-verified"], completed: [], invalidPhase: "vm_migration_validation_phase_invalid",
      allowedBlockers: ["destination_registry_exists"],
    });
    if (!matchesQuiesce(current) || !DIGEST.test(current.record.diskImport?.receiptSha256 || "")) {
      throw httpError(409, "vm_migration_validation_source_changed");
    }
    return current;
  }

  async function readSourceReconciliationState(transaction, input, references) {
    const current = await readFencedSource(transaction, input, references, {
      phases: ["authority-switched"], completed: [], invalidPhase: "vm_migration_source_reconciliation_phase_invalid",
      allowedBlockers: ["destination_registry_exists"],
    });
    const workspace = current.observation.workspace || {};
    const destination = await transaction.get(db.collection("vmRuntimes_v2").doc(input.workspaceId));
    const destinationData = destination.data() || {};
    if (workspace.migrationAuthority !== DESTINATION_AUTHORITY || workspace.migrationOperationId !== input.operationId ||
        workspace.agentRuntimeAuthorityState !== "released" || workspace.agentRuntimeBootInstanceId ||
        !destination.exists || destinationData.ownerUid !== input.ownerUid ||
        destinationData.migrationAuthority !== DESTINATION_AUTHORITY || destinationData.migrationOperationId !== input.operationId ||
        destinationData.backend !== "compute-engine" || destinationData.apiEnabled !== true || destinationData.state !== "active") {
      throw httpError(409, "vm_migration_source_reconciliation_authority_changed");
    }
    return current;
  }

  async function readRollbackState(transaction, input, references) {
    const current = await readFencedSource(transaction, input, references, {
      phases: ["rollback-draining"], completed: [], invalidPhase: "vm_migration_rollback_phase_invalid",
      allowedBlockers: ["destination_registry_exists"],
    });
    const workspace = current.observation.workspace || {};
    if (!current.record.sourceReconciliation || workspace.migrationAuthority !== DESTINATION_AUTHORITY ||
        workspace.migrationOperationId !== input.operationId || workspace.agentRuntimeAuthorityState !== "released" ||
        workspace.agentRuntimeBootInstanceId) {
      throw httpError(409, "vm_migration_rollback_authority_changed");
    }
    return current;
  }

  async function assertValidationSource(input, record) {
    const disk = await inspectDisk(input, record.importDestination);
    if (disk.diskId !== record.importDestination.diskId ||
        disk.lastAttachTimestamp !== (record.diskImport.diskLastAttachTimestamp ?? null)) {
      throw httpError(409, "vm_migration_validation_source_disk_changed");
    }
  }

  async function reserveValidationBoot(input) {
    const references = refs(input);
    if (typeof input.runnerImage !== "string" || !RUNNER_IMAGE.test(input.runnerImage)) {
      throw httpError(400, "vm_migration_validation_image_invalid");
    }
    if (!inspectDestinationDisk || !await authorize(input, "reserve-validation-boot")) {
      throw httpError(409, "vm_migration_validation_unverified");
    }
    const read = transaction => readValidationState(transaction, input, references);
    const before = await db.runTransaction(read, {readOnly: true});
    await assertValidationSource(input, before.record);
    const key = createHash("sha256").update(input.workspaceId + ":" + input.operationId).digest("hex").slice(0, 24);
    const validation = {reservedAtMs: now(), runnerImage: input.runnerImage, operationId: "validate-" + key,
      cloneDiskName: "mapache-val-disk-" + key, instanceName: "mapache-val-vm-" + key,
      receiptSha256: before.record.diskImport.receiptSha256};
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (current.record.validation) {
        const existing = current.record.validation;
        if (existing.runnerImage !== input.runnerImage || existing.receiptSha256 !== validation.receiptSha256) {
          throw httpError(409, "vm_migration_validation_reservation_conflict");
        }
        return status(current.record);
      }
      if (before.authorityStamps !== current.authorityStamps ||
          before.observation.observationSha256 !== current.observation.observationSha256) {
        throw httpError(409, "vm_migration_validation_observation_stale");
      }
      transaction.update(references.operation, {validation});
      return status({...current.record, validation});
    });
  }

  async function prepareValidationClone(input) {
    const references = refs(input);
    if (!inspectDestinationDisk || !ensureValidationClone || !await authorize(input, "prepare-validation-clone")) {
      throw httpError(409, "vm_migration_validation_unverified");
    }
    const read = transaction => readValidationState(transaction, input, references);
    const initial = await db.runTransaction(read, {readOnly: true});
    if (!initial.record.validation || initial.record.validation.receiptSha256 !== initial.record.diskImport.receiptSha256) {
      throw httpError(409, "vm_migration_validation_reservation_missing");
    }
    await assertValidationSource(input, initial.record);
    await db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (current.record.validation?.cloneRequestedAtMs !== undefined) return;
      if (initial.authorityStamps !== current.authorityStamps ||
          initial.observation.observationSha256 !== current.observation.observationSha256) {
        throw httpError(409, "vm_migration_validation_observation_stale");
      }
      transaction.update(references.operation, {"validation.cloneRequestedAtMs": now()});
    });
    const before = await db.runTransaction(read, {readOnly: true});
    const {validation, importDestination: destination, diskImport} = before.record;
    const descriptor = createRuntimeDescriptor({backend: COMPUTE_ENGINE_BACKEND, workspaceId: input.workspaceId, ownerUid: input.ownerUid,
      zone: destination.zone, region: destination.region, generation: destination.generation});
    const clone = await ensureValidationClone(descriptor, {sourceOperationId: destination.operationId, sourceDiskId: destination.diskId,
      sourceLastAttachTimestamp: diskImport.diskLastAttachTimestamp ?? null, cloneDiskName: validation.cloneDiskName,
      operationId: validation.operationId});
    if (clone?.cloneDiskName !== validation.cloneDiskName || clone.sourceDiskId !== destination.diskId ||
        typeof clone.cloneDiskId !== "string" || !DISK_ID.test(clone.cloneDiskId) || clone.cloneDiskId === destination.diskId) {
      throw httpError(409, "vm_migration_validation_clone_unverified");
    }
    await assertValidationSource(input, before.record);
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (current.record.validation?.cloneDiskId) {
        if (current.record.validation.cloneDiskId !== clone.cloneDiskId) throw httpError(409, "vm_migration_validation_clone_conflict");
        return status(current.record);
      }
      if (before.authorityStamps !== current.authorityStamps ||
          before.observation.observationSha256 !== current.observation.observationSha256) {
        throw httpError(409, "vm_migration_validation_observation_stale");
      }
      const verified = {...validation, cloneDiskId: clone.cloneDiskId, cloneVerifiedAtMs: now()};
      transaction.update(references.operation, {validation: verified});
      return status({...current.record, validation: verified});
    });
  }

  async function startValidationBoot(input) {
    const references = refs(input);
    if (!inspectDestinationDisk || !startValidationVm || !await authorize(input, "start-validation-boot")) {
      throw httpError(409, "vm_migration_validation_unverified");
    }
    const read = transaction => readValidationState(transaction, input, references);
    const initial = await db.runTransaction(read, {readOnly: true});
    if (!DISK_ID.test(initial.record.validation?.cloneDiskId || "")) throw httpError(409, "vm_migration_validation_clone_unverified");
    await assertValidationSource(input, initial.record);
    const runtime = await db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (initial.authorityStamps !== current.authorityStamps ||
          initial.observation.observationSha256 !== current.observation.observationSha256) {
        throw httpError(409, "vm_migration_validation_observation_stale");
      }
      const time = now();
      const reserved = await reserveValidationRuntime({db, transaction, record: current.record, now: time});
      if (current.record.validation.bootRequestedAtMs === undefined) {
        transaction.update(references.operation, {"validation.bootRequestedAtMs": time, "validation.deadlineMs": reserved.deadlineMs});
      }
      return reserved;
    });
    const before = await db.runTransaction(read, {readOnly: true});
    const {validation, importDestination} = before.record;
    if (validation.deadlineMs !== runtime.deadlineMs || validation.deadlineMs <= now()) {
      throw httpError(409, "vm_migration_validation_deadline_expired");
    }
    await assertValidationSource(input, before.record);
    const descriptor = createRuntimeDescriptor({backend: COMPUTE_ENGINE_BACKEND, workspaceId: input.workspaceId, ownerUid: input.ownerUid,
      zone: importDestination.zone, region: importDestination.region, generation: importDestination.generation,
      dataDiskName: validation.cloneDiskName, instanceName: validation.instanceName});
    const evidence = await startValidationVm(descriptor, {operationId: validation.operationId, cloneDiskId: validation.cloneDiskId,
      sourceDiskId: importDestination.diskId, runnerImage: validation.runnerImage, sessionId: runtime.sessionId,
      credentials: runtime.credentials});
    if (evidence?.instanceName !== validation.instanceName || evidence.cloneDiskId !== validation.cloneDiskId ||
        typeof evidence.instanceId !== "string" || !DISK_ID.test(evidence.instanceId)) {
      throw httpError(409, "vm_migration_validation_instance_unverified");
    }
    await assertValidationSource(input, before.record);
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      const stored = current.record.validation;
      if (stored.instanceId) {
        if (stored.instanceId !== evidence.instanceId) throw httpError(409, "vm_migration_validation_instance_conflict");
        return status(current.record);
      }
      if (before.authorityStamps !== current.authorityStamps ||
          before.observation.observationSha256 !== current.observation.observationSha256) {
        throw httpError(409, "vm_migration_validation_observation_stale");
      }
      await reserveValidationRuntime({db, transaction, record: current.record, now: now()});
      const verified = {...stored, instanceId: evidence.instanceId, instanceStartedAtMs: now()};
      transaction.update(references.operation, {validation: verified});
      return status({...current.record, validation: verified});
    });
  }

  async function cleanupValidationBoot(input) {
    const references = refs(input);
    if (!inspectDestinationDisk || !deleteValidationResources || !await authorize(input, "cleanup-validation-boot")) {
      throw httpError(409, "vm_migration_validation_unverified");
    }
    const read = transaction => readValidationState(transaction, input, references);
    const initial = await db.runTransaction(read, {readOnly: true});
    const validation = initial.record.validation;
    if (!validation?.cloneDiskName || !validation.instanceName || !validation.operationId) {
      throw httpError(409, "vm_migration_validation_cleanup_missing");
    }
    if (validation.cleanedAtMs !== undefined) return status(initial.record);
    const destination = initial.record.importDestination;
    const descriptor = createRuntimeDescriptor({backend: COMPUTE_ENGINE_BACKEND, workspaceId: input.workspaceId, ownerUid: input.ownerUid,
      zone: destination.zone, region: destination.region, generation: destination.generation,
      dataDiskName: validation.cloneDiskName, instanceName: validation.instanceName});
    const cloneDiskId = validation.cloneDiskId || (await inspectDestinationDisk(descriptor, {operationId: validation.operationId})).diskId;
    await assertValidationSource(input, initial.record);
    const result = await deleteValidationResources(descriptor, {operationId: validation.operationId,
      cloneDiskId, sourceDiskId: destination.diskId});
    await assertValidationSource(input, initial.record);
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      const stored = current.record.validation;
      if (stored.cleanedAtMs !== undefined) return status(current.record);
      if (initial.authorityStamps !== current.authorityStamps ||
          initial.observation.observationSha256 !== current.observation.observationSha256) {
        throw httpError(409, "vm_migration_validation_observation_stale");
      }
      const cleanedAtMs = now();
      const next = {...stored, cleanedAtMs, cleanupInstanceDeleted: result.instanceDeleted === true,
        cleanupDiskDeleted: result.diskDeleted === true};
      transaction.update(references.operation, {validation: next});
      return status({...current.record, validation: next});
    });
  }

  async function cleanupImportedDisk(input) {
    const references = refs(input);
    if (!inspectDestinationDisk || !deleteImportedDisk || !await authorize(input, "cleanup-imported-disk")) {
      throw httpError(409, "vm_migration_disk_cleanup_unverified");
    }
    const read = transaction => readValidationState(transaction, input, references);
    const initial = await db.runTransaction(read, {readOnly: true});
    if (initial.record.destinationCleanup?.cleanedAtMs !== undefined) return status(initial.record);
    if (initial.record.validation?.cleanedAtMs === undefined) {
      throw httpError(409, "vm_migration_validation_cleanup_required");
    }
    const destination = initial.record.importDestination;
    if (!destination) throw httpError(409, "vm_migration_disk_destination_unregistered");
    await assertValidationSource(input, initial.record);
    const descriptor = createRuntimeDescriptor({backend: COMPUTE_ENGINE_BACKEND, workspaceId: input.workspaceId, ownerUid: input.ownerUid,
      zone: destination.zone, region: destination.region, generation: destination.generation});
    const result = await deleteImportedDisk(descriptor, {operationId: destination.operationId, diskId: destination.diskId});
    if (result?.diskDeleted !== true || String(result.diskId) !== String(destination.diskId)) {
      throw httpError(409, "vm_migration_disk_cleanup_unverified");
    }
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (current.record.destinationCleanup?.cleanedAtMs !== undefined) return status(current.record);
      if (initial.authorityStamps !== current.authorityStamps ||
          initial.observation.observationSha256 !== current.observation.observationSha256) {
        throw httpError(409, "vm_migration_disk_cleanup_stale");
      }
      const destinationCleanup = {cleanedAtMs: now(), diskDeleted: true, diskId: destination.diskId};
      transaction.update(references.operation, {destinationCleanup});
      return status({...current.record, destinationCleanup});
    });
  }

  async function reviewCutoverGates(input) {
    const references = refs(input);
    if (!inspectDestinationRuntime || !await authorize(input, "review-cutover-gates")) {
      throw httpError(409, "vm_migration_cutover_review_unverified");
    }
    const read = transaction => readValidationState(transaction, input, references);
    const before = await db.runTransaction(read, {readOnly: true});
    let runtimeEvidence = null;
    try {
      const evidence = await inspectDestinationRuntime({workspaceId: input.workspaceId, ownerUid: input.ownerUid,
        operationId: input.operationId, record: before.record});
      runtimeEvidence = validateDestinationRuntimeEvidence(evidence, before.record);
    } catch {
      // The operator projection is intentionally bounded. Provider errors and
      // runtime addresses never become a migration approval or public detail.
    }
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (before.observation.observationSha256 !== current.observation.observationSha256 ||
          before.authorityStamps !== current.authorityStamps) throw httpError(409, "vm_migration_cutover_review_stale");
      return cutoverReview(current.record, {runtimeEvidence, sourceBlockers: current.observation.blockers});
    }, {readOnly: true});
  }

  async function switchAuthority(input) {
    const references = refs(input);
    if (!inspectDestinationRuntime || !await authorize(input, "switch-authority")) {
      throw httpError(409, "vm_migration_cutover_unverified");
    }
    const existing = await references.operation.get();
    if (existing.exists) {
      const existingRecord = existing.data();
      requireOwner(existingRecord, input);
      if (existingRecord.authoritySwitch) return status(existingRecord);
    }
    const read = transaction => readValidationState(transaction, input, references);
    const before = await db.runTransaction(read, {readOnly: true});
    if (before.record.authoritySwitch) return status(before.record);
    let runtimeEvidence;
    try {
      const evidence = await inspectDestinationRuntime({workspaceId: input.workspaceId, ownerUid: input.ownerUid,
        operationId: input.operationId, record: before.record});
      runtimeEvidence = validateDestinationRuntimeEvidence(evidence, before.record);
    } catch {
      throw httpError(409, "vm_migration_destination_runtime_unverified");
    }
    const review = cutoverReview(before.record, {runtimeEvidence, sourceBlockers: before.observation.blockers});
    if (!review.readyForCutover) throw httpError(409, "vm_migration_cutover_gates_blocked");
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (current.record.authoritySwitch) return status(current.record);
      if (before.observation.observationSha256 !== current.observation.observationSha256 ||
          before.authorityStamps !== current.authorityStamps) throw httpError(409, "vm_migration_cutover_switch_stale");

      const sourceData = current.observation.workspace || {};
      if (sourceData.migrationAuthority && sourceData.migrationAuthority !== "legacy") {
        throw httpError(409, "vm_migration_authority_changed");
      }
      if (sourceData.ownerUid !== input.ownerUid ||
          sourceData.agentRuntimeGeneration !== current.record.sourceGeneration ||
          sourceData.agentRuntimeBootInstanceId) {
        throw httpError(409, "vm_migration_authority_changed");
      }

      const destinationRef = db.collection("vmRuntimes_v2").doc(input.workspaceId);
      const destination = await transaction.get(destinationRef);
      const destinationData = destination.data() || {};
      const sessionRef = destinationRef.collection("sessions").doc(runtimeEvidence.sessionId);
      const routeRef = db.collection("vmGatewayRoutes_v2").doc(destinationData.gatewayHost || "invalid");
      const [session, route] = await Promise.all([transaction.get(sessionRef), transaction.get(routeRef)]);
      const sessionData = session.data() || {};
      const routeData = route.data() || {};
      if (!destination.exists || destinationData.ownerUid !== input.ownerUid ||
          destinationData.backend !== "compute-engine" || destinationData.apiEnabled === true ||
          destinationData.state !== "active" || destinationData.generation !== runtimeEvidence.destinationGeneration ||
          destinationData.currentSessionId !== runtimeEvidence.sessionId ||
          (destinationData.migrationOperationId && destinationData.migrationOperationId !== input.operationId) ||
          sessionData.ownerUid !== input.ownerUid || sessionData.generation !== destinationData.generation ||
          sessionData.state !== "active" || routeData.workspaceId !== input.workspaceId ||
          routeData.ownerUid !== input.ownerUid || routeData.enabled !== true ||
          routeData.generation !== destinationData.generation || routeData.sessionId !== runtimeEvidence.sessionId) {
        throw httpError(409, "vm_migration_destination_authority_changed");
      }

      const switchedAtMs = now();
      const authoritySwitch = {
        version: 1,
        state: "switched",
        switchedAtMs,
        sourceGeneration: current.record.sourceGeneration,
        destinationGeneration: runtimeEvidence.destinationGeneration,
        destinationSessionId: runtimeEvidence.sessionId,
        diskReceiptSha256: runtimeEvidence.diskReceiptSha256,
        runnerImageRefSha256: runtimeEvidence.runnerImageRefSha256,
        healthPath: runtimeEvidence.healthPath,
      };
      transaction.update(references.source, {
        migrationAuthority: DESTINATION_AUTHORITY,
        migrationOperationId: input.operationId,
        migrationSourceGeneration: current.record.sourceGeneration,
        migrationDestinationGeneration: runtimeEvidence.destinationGeneration,
        migrationCutoverAtMs: switchedAtMs,
        agentRuntimeAuthorityState: "released",
        agentRuntimeSessionId: null,
        agentRuntimeState: "released",
        agentRuntimeBootInstanceId: null,
      });
      transaction.update(destinationRef, {
        apiEnabled: true,
        migrationOperationId: input.operationId,
        migrationSourceGeneration: current.record.sourceGeneration,
        migrationAuthority: DESTINATION_AUTHORITY,
        migrationCutoverAtMs: switchedAtMs,
      });
      transaction.update(references.fence, {
        phase: "cutover",
        authority: "destination",
        destinationGeneration: runtimeEvidence.destinationGeneration,
        cutoverAtMs: switchedAtMs,
      });
      transaction.update(references.operation, {
        phase: "authority-switched",
        authoritySwitch,
        updatedAtMs: switchedAtMs,
      });
      return status({...current.record, phase: "authority-switched", authoritySwitch});
    });
  }

  async function reconcileSource(input) {
    const references = refs(input);
    if (!inspectCompute || !inspectStorage || !await authorize(input, "reconcile-source")) {
      throw httpError(409, "vm_migration_source_reconciliation_unverified");
    }
    const existing = await references.operation.get();
    if (existing.exists) {
      const existingRecord = existing.data();
      requireOwner(existingRecord, input);
      if (existingRecord.sourceReconciliation) return status(existingRecord);
    }
    const read = transaction => readSourceReconciliationState(transaction, input, references);
    const before = await db.runTransaction(read, {readOnly: true});
    if (before.record.sourceReconciliation) return status(before.record);
    const {providerSha256, discoverySha256, storageSha256} = await readProviders(input, before.observation);
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (current.record.sourceReconciliation) return status(current.record);
      if (before.observation.sourceObservationSha256 !== current.observation.sourceObservationSha256 ||
          before.authorityStamps !== current.authorityStamps) {
        throw httpError(409, "vm_migration_source_reconciliation_stale");
      }
      const reconciledAtMs = now();
      const sourceReconciliation = {
        version: 1,
        state: "verified",
        reconciledAtMs,
        sourceGeneration: current.record.sourceGeneration,
        observedSessions: current.observation.sessions.length,
        providerSha256,
        discoverySha256,
        storageSha256,
        sourceObservationSha256: current.observation.sourceObservationSha256,
      };
      transaction.update(references.operation, {sourceReconciliation, updatedAtMs: reconciledAtMs});
      return status({...current.record, sourceReconciliation});
    });
  }

  async function beginRollback(input) {
    const references = refs(input);
    if (!await authorize(input, "begin-rollback")) throw httpError(409, "vm_migration_rollback_unverified");
    const existing = await references.operation.get();
    if (existing.exists) {
      const existingRecord = existing.data();
      requireOwner(existingRecord, input);
      if (["rollback-draining", "rolled-back"].includes(existingRecord.phase)) return status(existingRecord);
    }
    const read = transaction => readSourceReconciliationState(transaction, input, references);
    const before = await db.runTransaction(read, {readOnly: true});
    if (!before.record.sourceReconciliation) throw httpError(409, "vm_migration_source_reconciliation_required");
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (["rollback-draining", "rolled-back"].includes(current.record.phase)) return status(current.record);
      if (before.authorityStamps !== current.authorityStamps) throw httpError(409, "vm_migration_rollback_stale");

      const destinationRef = db.collection("vmRuntimes_v2").doc(input.workspaceId);
      const destination = await transaction.get(destinationRef);
      const destinationData = destination.data() || {};
      const sessionId = destinationData.currentSessionId;
      const sessionRef = destinationRef.collection("sessions").doc(sessionId || "invalid");
      const routeRef = db.collection("vmGatewayRoutes_v2").doc(destinationData.gatewayHost || "invalid");
      const [session, route] = await Promise.all([transaction.get(sessionRef), transaction.get(routeRef)]);
      const sessionData = session.data() || {};
      const routeData = route.data() || {};
      if (!destination.exists || destinationData.ownerUid !== input.ownerUid ||
          destinationData.backend !== COMPUTE_ENGINE_BACKEND || destinationData.apiEnabled !== true ||
          destinationData.migrationAuthority !== DESTINATION_AUTHORITY || destinationData.migrationOperationId !== input.operationId ||
          destinationData.generation !== current.record.importDestination?.generation || destinationData.state !== "active" ||
          !sessionId || sessionData.ownerUid !== input.ownerUid || sessionData.generation !== destinationData.generation ||
          sessionData.state !== "active" || routeData.workspaceId !== input.workspaceId ||
          routeData.ownerUid !== input.ownerUid || routeData.enabled !== true ||
          routeData.generation !== destinationData.generation || routeData.sessionId !== sessionId) {
        throw httpError(409, "vm_migration_destination_authority_changed");
      }

      const startedAtMs = now();
      const rollback = {version: 1, state: "draining-destination", startedAtMs,
        sourceGeneration: current.record.sourceGeneration, destinationGeneration: destinationData.generation,
        destinationSessionId: sessionId};
      transaction.update(destinationRef, {apiEnabled: false, lifecycleEnabled: false, state: "stopping", rollbackStartedAtMs: startedAtMs});
      transaction.update(sessionRef, {state: "stopping", rollbackStartedAtMs: startedAtMs});
      transaction.update(routeRef, {enabled: false, rollbackStartedAtMs: startedAtMs});
      transaction.update(references.fence, {phase: "rollback-draining", authority: "destination", rollbackStartedAtMs: startedAtMs});
      transaction.update(references.operation, {phase: "rollback-draining", rollback, updatedAtMs: startedAtMs});
      return status({...current.record, phase: "rollback-draining", rollback});
    });
  }

  async function completeRollback(input) {
    const references = refs(input);
    if (!inspectDestinationRollback || !await authorize(input, "complete-rollback")) {
      throw httpError(409, "vm_migration_rollback_unverified");
    }
    const existing = await references.operation.get();
    if (existing.exists) {
      const existingRecord = existing.data();
      requireOwner(existingRecord, input);
      if (existingRecord.phase === "rolled-back") return status(existingRecord);
    }
    const read = transaction => readRollbackState(transaction, input, references);
    const before = await db.runTransaction(read, {readOnly: true});
    const reverseImport = verifyReverseImportReceipt(input.reverseImport, before.record);
    let destinationEvidence;
    try {
      destinationEvidence = verifyDestinationRollbackEvidence(
          await inspectDestinationRollback({workspaceId: input.workspaceId, ownerUid: input.ownerUid,
            operationId: input.operationId, record: before.record}), before.record);
    } catch (error) {
      if (error?.publicMessage === "vm_migration_destination_writers_not_stopped") throw error;
      throw httpError(409, "vm_migration_destination_writers_not_stopped");
    }
    return db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (current.record.phase === "rolled-back") return status(current.record);
      if (before.authorityStamps !== current.authorityStamps) throw httpError(409, "vm_migration_rollback_stale");
      if (reverseImport.sourceObservationSha256 !== current.observation.sourceObservationSha256) {
        throw httpError(409, "vm_migration_reverse_import_stale");
      }

      const destinationRef = db.collection("vmRuntimes_v2").doc(input.workspaceId);
      const destination = await transaction.get(destinationRef);
      const destinationData = destination.data() || {};
      const sessionId = destinationData.currentSessionId;
      const sessionRef = destinationRef.collection("sessions").doc(sessionId || "invalid");
      const routeRef = db.collection("vmGatewayRoutes_v2").doc(destinationData.gatewayHost || "invalid");
      const [session, route] = await Promise.all([transaction.get(sessionRef), transaction.get(routeRef)]);
      const sessionData = session.data() || {};
      const routeData = route.data() || {};
      if (!destination.exists || destinationData.ownerUid !== input.ownerUid ||
          destinationData.backend !== COMPUTE_ENGINE_BACKEND || destinationData.migrationOperationId !== input.operationId ||
          destinationData.generation !== current.record.importDestination?.generation ||
          destinationData.apiEnabled !== false || !["stopping", "stopped"].includes(destinationData.state) ||
          sessionData.ownerUid !== input.ownerUid || sessionData.generation !== destinationData.generation ||
          !["stopping", "stopped"].includes(sessionData.state) || routeData.workspaceId !== input.workspaceId ||
          routeData.ownerUid !== input.ownerUid || routeData.enabled !== false ||
          routeData.generation !== destinationData.generation || routeData.sessionId !== sessionId ||
          sessionId !== destinationEvidence.sessionId) {
        throw httpError(409, "vm_migration_destination_writers_changed");
      }

      const completedAtMs = now();
      const rollback = {
        version: 1,
        state: "source-restored",
        startedAtMs: current.record.rollback?.startedAtMs ?? null,
        completedAtMs,
        sourceGeneration: current.record.sourceGeneration,
        destinationGeneration: destinationData.generation,
        destinationSessionId: sessionId,
        destinationDiskId: destinationEvidence.diskId,
        destinationDiskRetained: true,
        destinationWritersStopped: true,
        destinationEvidence,
        reverseImport,
      };
      transaction.update(references.source, {
        migrationAuthority: "legacy",
        migrationRollbackOperationId: input.operationId,
        migrationRollbackAtMs: completedAtMs,
        agentRuntimeAuthorityState: "released",
        agentRuntimeSessionId: null,
        agentRuntimeState: "stopped",
        agentRuntimeBootInstanceId: null,
      });
      transaction.update(destinationRef, {
        apiEnabled: false,
        lifecycleEnabled: false,
        state: "stopped",
        migrationAuthority: "legacy",
        migrationRollbackOperationId: input.operationId,
        migrationRollbackAtMs: completedAtMs,
        bootId: null,
        leaseExpiresAt: 0,
      });
      transaction.update(sessionRef, {state: "stopped", bootId: null, leaseExpiresAt: 0,
        migrationRollbackOperationId: input.operationId, migrationRollbackAtMs: completedAtMs});
      transaction.update(routeRef, {enabled: false, migrationAuthority: "legacy", migrationRollbackAtMs: completedAtMs});
      transaction.delete(references.fence);
      transaction.delete(storageFenceRef(db, current.record.scope, input.ownerUid));
      transaction.update(references.operation, {phase: "rolled-back", rollback, updatedAtMs: completedAtMs});
      return status({...current.record, phase: "rolled-back", rollback});
    });
  }

  async function getCapturedPrefix(input) {
    const references = refs(input);
    if (!await authorize(input, "read-prefix-capture")) throw httpError(409, "vm_migration_prefix_capture_unverified");
    return db.runTransaction(async transaction => {
      const current = await readFencedSource(transaction, input, references, {
        phases: ["prefix-captured", "disk-import-verified"], completed: [], invalidPhase: "vm_migration_prefix_capture_phase_invalid",
      });
      if (!matchesQuiesce(current)) throw httpError(409, "vm_migration_prefix_capture_source_changed");
      const {prefixCapture: capture, scope, quiesce} = current.record;
      if (capture?.version !== 1 || capture.sha256 !== quiesce.storageSha256 ||
          !Number.isSafeInteger(capture.chunkCount) || capture.chunkCount < 0 || capture.chunkCount > MAX_CAPTURE_CHUNKS) {
        throw httpError(409, "legacy_storage_capture_invalid");
      }
      const inventory = references.operation.collection("prefixInventory");
      const chunks = await Promise.all(Array.from({length: capture.chunkCount}, (_, index) =>
        transaction.get(inventory.doc(String(index)))));
      try {
        const rows = chunks.flatMap(snapshot => {
          const value = JSON.parse(snapshot.get("rowsJson"));
          if (!Array.isArray(value)) throw Error("invalid capture chunk");
          return value;
        });
        const prepared = prepareStorageCapture(scope, rows, capture.sha256);
        if (prepared.objectCount !== capture.objectCount || prepared.chunks.some((value, index) =>
          value !== chunks[index]?.get("rowsJson")) || prepared.chunks.length !== capture.chunkCount) {
          throw Error("invalid capture chunk");
        }
        const {workspaceId, ownerUid, operationId, sourceGeneration} = current.record;
        const {workspace, sessions} = current.observation;
        const mainSessions = sessions.filter(isMainRuntime);
        const canonical = mainSessions.find(session => session.id === workspace.canonicalSessionId) ||
          (mainSessions.length === 1 ? mainSessions[0] : null);
        return {workspaceId, ownerUid, operationId, sourceGeneration, scope, sha256: capture.sha256, rows,
          checkpointPointers: {agent: workspace.agentRuntimeCheckpoint ?? null, workspace: workspace.agentRuntimeWorkspaceFiles ?? null},
          mainSessionIds: mainSessions.map(session => session.id),
          archivePolicy: {home: sessionHomePolicyMetadata(workspace), chromeSeed: canonical?.chromeProfileSeed ?? null,
            ambiguousChromeSeed: !canonical && mainSessions.some(session => session.chromeProfileSeed)}};
      } catch {
        throw httpError(409, "legacy_storage_capture_invalid");
      }
    }, {readOnly: true});
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
      if (!["reserved", "quiesced", "prefix-captured", "disk-import-verified"].includes(record.phase)) {
        throw httpError(409, "vm_migration_abort_phase_invalid");
      }
      if (record.validation?.cloneRequestedAtMs !== undefined) throw httpError(409, "vm_migration_validation_cleanup_required");
      if (record.importDestination && record.destinationCleanup?.cleanedAtMs === undefined) {
        throw httpError(409, "vm_migration_disk_cleanup_required");
      }
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
  return {getStatus, reserve, confirmQuiesced, capturePrefix, getCapturedPrefix, registerImportDisk, verifyDiskImport,
    reserveValidationBoot, prepareValidationClone, startValidationBoot, cleanupValidationBoot, cleanupImportedDisk,
    reviewCutoverGates, switchAuthority, reconcileSource, beginRollback, completeRollback, abort};
}

module.exports = {createVmMigrationCoordinator};
