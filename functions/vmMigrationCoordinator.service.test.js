"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createHash, randomUUID} = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {Readable} = require("node:stream");
const {gzipSync} = require("node:zlib");
const admin = require("firebase-admin");
const {CRC32C} = require("@google-cloud/storage");
const tar = require("tar-stream");
const {createVmMigrationCoordinator} = require("./vmMigrationCoordinator.service");
const {createVmMigrationPreflight} = require("./vmMigrationPreflight.service");
const {createRuntimeDescriptor, COMPUTE_ENGINE_BACKEND} = require("./runtimeProvider.helpers");
const {createWorkspaceSharedStorageService, deriveWorkspaceBucketName} = require("./workspaceSharedStorage.service");
const {createWorkspaceService} = require("./workspace.service");
const {createMachineConfigurationService} = require("./machineConfiguration.service");
const {createWorkspaceStorageBackupService} = require("./workspaceStorageBackup.service");
const {createWorkspaceRuntimeScheduleService} = require("./workspaceRuntimeSchedule.service");
const {createSessionLifecycleService} = require("./sessionLifecycle.service");
const {createVmMigrationStorageObserver} = require("./vmMigrationStorageObservation.service");

test("operator reservation requires a current ready source audit", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = admin.initializeApp({projectId: "demo-mapache-cutover"}, randomUUID());
  try {
    const db = app.firestore();
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const bucket = "fixture-bucket";
    await db.collection("workspaces").doc(workspaceId).create({ownerUid, bucket,
      storagePrefix: `workspaces/${ownerUid}/staging`, agentRuntimeGeneration: 7});
    const target = {workspaceId, ownerUid};
    const {observationSha256, sourceObservationSha256, sourceGeneration} = await createVmMigrationPreflight({db})(target);
    const input = {...target, operationId: "audit-gated", observationSha256};
    const coordinator = createVmMigrationCoordinator({db, defaultBucket: bucket, requireSourceAudit: true,
      authorize: async () => true});
    await assert.rejects(coordinator.reserve(input), {publicMessage: "vm_migration_source_audit_required"});
    await db.collection("vmMigrationSourceAudits_v2").doc(workspaceId).create({
      schemaVersion: 1, state: "ready", decision: "admit-reservation", workspaceId, ownerUid, sourceGeneration,
      observationSha256, sourceObservationSha256, scope: {bucket, prefix: `workspaces/${ownerUid}/staging`, workspaceKey: "staging"},
      blockers: [], evidenceSha256: "a".repeat(64), sourceRetained: true,
    });
    const reserved = await coordinator.reserve(input);
    assert.equal(reserved.phase, "reserved");
    assert.equal(reserved.sourceAuditSha256, "a".repeat(64));
  } finally {
    await app.delete();
  }
});

test("reservation and abort are atomic under concurrent callers and fail closed on changed authority", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const projectId = "demo-mapache-cutover";
  const app = admin.initializeApp({projectId}, randomUUID());
  try {
    const db = app.firestore();
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const defaultBucket = "fixture-bucket";
    const source = db.collection("workspaces").doc(workspaceId);
    await source.create({ownerUid, bucket: defaultBucket, storagePrefix: `workspaces/${ownerUid}/staging`, agentRuntimeGeneration: 7});
    const target = {ownerUid, workspaceId};
    const probe = createVmMigrationPreflight({db});
    const {observationSha256} = await probe(target);
    const args = {...target, observationSha256, operationId: "one"};
    const denied = createVmMigrationCoordinator({db, defaultBucket});
    await assert.rejects(denied.reserve(args), {publicMessage: "vm_migration_fence_rollout_unverified"});
    const coordinator = createVmMigrationCoordinator({db, defaultBucket, authorize: async () => true});
    const alias = db.collection("workspaces").doc("alias-" + randomUUID());
    await alias.create({ownerUid, bucket: defaultBucket, storagePrefix: `workspaces/${ownerUid}/staging`});
    await assert.rejects(coordinator.reserve(args), {publicMessage: "vm_migration_storage_prefix_conflict"});
    await alias.delete();
    const operations = [args, {...args, operationId: "two"}];
    const results = await Promise.allSettled(operations.map(operation => coordinator.reserve(operation)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const winner = results.find(result => result.status === "fulfilled").value;
    const winnerArgs = operations.find(operation => operation.operationId === winner.operationId);
    assert.deepEqual(await coordinator.reserve(winnerArgs), winner);
    assert.deepEqual(await coordinator.getStatus(winnerArgs), winner);
    assert.equal(winner.sourceGeneration, 7);
    assert.equal(winner.readyForCutover, false);
    assert.deepEqual(winner.blockers, []);
    assert.equal(winner.nextAction, "confirm-quiesced");
    assert.equal(winner.downtimeStartedAtMs, null);
    assert.match(winner.recoveryAction, /confirm-quiesced/);

    const workspaceFence = db.collection("vmMigrationFences_v2").doc(workspaceId);
    const prefix = db.doc(`vmMigrationStorageFences_v2/${defaultBucket}/owners/${ownerUid}/prefixes/staging`);
    assert.equal((await workspaceFence.get()).get("operationId"), winner.operationId);
    assert.equal((await prefix.get()).get("operationId"), winner.operationId);
    const destination = db.collection("vmRuntimes_v2").doc(workspaceId);
    await destination.create({ownerUid});
    await assert.rejects(coordinator.abort(winnerArgs), {publicMessage: "vm_migration_authority_changed"});
    assert.equal((await workspaceFence.get()).exists, true);
    assert.equal((await prefix.get()).exists, true);
    await destination.delete();
    await source.update({runtimeProviderDescriptor: {backend: "compute-engine"}});
    await assert.rejects(coordinator.abort(winnerArgs), {publicMessage: "vm_migration_authority_changed"});
    await source.update({runtimeProviderDescriptor: admin.firestore.FieldValue.delete()});
    const aborted = await coordinator.abort(winnerArgs);
    assert.equal(aborted.phase, "aborted");
    assert.deepEqual(await coordinator.abort(winnerArgs), aborted);
    assert.deepEqual(await coordinator.reserve(winnerArgs), aborted);
    assert.equal((await workspaceFence.get()).exists, false);
    assert.equal((await prefix.get()).exists, false);
    await source.update({agentRuntimeGeneration: 8});
    await assert.rejects(coordinator.reserve({...args, operationId: "stale"}), {publicMessage: "vm_migration_observation_stale"});
  } finally {
    await app.delete();
  }
});

test("quiesce records a historical receipt only for stable source and fence observations", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = admin.initializeApp({projectId: "demo-mapache-cutover"}, randomUUID());
  try {
    const db = app.firestore();
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const defaultBucket = "fixture-bucket";
    const source = db.collection("workspaces").doc(workspaceId);
    await source.create({ownerUid, bucket: defaultBucket, storagePrefix: `workspaces/${ownerUid}/staging`,
      agentRuntimeGeneration: 7});
    const target = {ownerUid, workspaceId};
    const maintenance = db.collection("workspaceStorageRecoveryReservations").doc(workspaceId);
    await maintenance.create({ownerUid, workspaceId, state: "reserved", reservationId: "old-recovery",
      expiresAt: "2000-01-01T00:00:00Z"});
    const {observationSha256} = await createVmMigrationPreflight({db})(target);
    const input = {...target, observationSha256, operationId: "quiesce"};
    const workspaceFence = db.collection("vmMigrationFences_v2").doc(workspaceId);
    const prefix = db.doc(`vmMigrationStorageFences_v2/${defaultBucket}/owners/${ownerUid}/prefixes/staging`);
    const operation = db.doc(`vmMigrationOperations_v2/${workspaceId}/operations/quiesce`);
    const computeEvidence = {recordedComputeClear: true, providerObservationSha256: "a".repeat(64), blockers: [],
      discovery: {scannedRegionsClear: true, evidenceSha256: "b".repeat(64)}};
    const storageDigest = "c".repeat(64);
    const storageEvidence = {stable: true, firstSha256: storageDigest, secondSha256: storageDigest, blockers: []};
    let computeProbe = async () => computeEvidence;
    let storageProbe = async () => storageEvidence;
    let probes = 0;
    const options = {db, defaultBucket, now: () => 42,
      inspectCompute: async () => { probes++; return computeProbe(); },
      inspectStorage: async () => storageProbe()};
    const coordinator = createVmMigrationCoordinator({...options, authorize: async () => true});
    const reserved = await coordinator.reserve(input);
    assert.ok(reserved.blockers.includes("legacy_storage_recovery_reservation_unresolved"));
    assert.equal(reserved.nextAction, "confirm-quiesced");
    assert.equal(reserved.downtimeStartedAtMs, null);
    assert.match(reserved.recoveryAction, /Drain/);
    await assert.rejects(coordinator.confirmQuiesced(input), {publicMessage: "vm_migration_writers_not_drained"});
    const recovery = createWorkspaceStorageBackupService({db, admin});
    await recovery.releaseMaintenanceReservation(ownerUid, workspaceId, "old-recovery");
    const recoveryWrite = maintenance.collection("pending").doc("orphan");
    await recoveryWrite.create({ownerUid});
    await assert.rejects(coordinator.confirmQuiesced(input), {publicMessage: "vm_migration_writers_not_drained"});
    await recoveryWrite.delete();
    await assert.rejects(createVmMigrationCoordinator(options).confirmQuiesced(input),
        {publicMessage: "vm_migration_quiesce_unverified"});
    const pending = db.doc(`vmLegacyUploads_v2/${workspaceId}/pending/unresolved`);
    await pending.create({});
    await assert.rejects(coordinator.confirmQuiesced(input), {publicMessage: "vm_migration_writers_not_drained"});
    assert.equal(probes, 0);
    await pending.delete();
    const iam = db.doc(`vmLegacySharedStorage_v2/${workspaceId}/pending/ambiguous`);
    await iam.create({});
    await assert.rejects(coordinator.confirmQuiesced(input), {publicMessage: "vm_migration_writers_not_drained"});
    assert.equal(probes, 0);
    await iam.delete();

    computeProbe = async () => ({...computeEvidence, discovery: {scannedRegionsClear: false}});
    await assert.rejects(coordinator.confirmQuiesced(input), {publicMessage: "vm_migration_compute_not_quiesced"});
    computeProbe = async () => computeEvidence;
    storageProbe = async () => ({...storageEvidence, blockers: ["legacy_persistent_home_archive_missing"]});
    await assert.rejects(coordinator.confirmQuiesced(input), {publicMessage: "vm_migration_storage_not_quiesced"});
    storageProbe = async () => ({...storageEvidence, secondSha256: "d".repeat(64)});
    await assert.rejects(coordinator.confirmQuiesced(input), {publicMessage: "vm_migration_storage_not_quiesced"});
    storageProbe = async () => storageEvidence;

    for (const [reference, update] of [
      [source, {title: "Changed during provider read"}],
      [prefix, {testVersion: 2}],
      [operation, {testVersion: 2}],
    ]) {
      computeProbe = async () => { await reference.update(update); return computeEvidence; };
      await assert.rejects(coordinator.confirmQuiesced(input), {publicMessage: "vm_migration_quiesce_observation_stale"});
    }
    assert.deepEqual(await coordinator.getStatus(input), reserved);
    computeProbe = async () => computeEvidence;
    const receipts = await Promise.all([coordinator.confirmQuiesced(input), coordinator.confirmQuiesced(input)]);
    const [receipt] = receipts;
    assert.deepEqual(receipts, [receipt, receipt]);
    assert.equal(receipt.phase, "quiesced");
    assert.equal(receipt.readyForCutover, false);
    assert.equal(receipt.quiescedAtMs, 42);
    assert.deepEqual(receipt.blockers, []);
    assert.equal(receipt.downtimeStartedAtMs, 42);
    assert.equal(receipt.nextAction, "capture-prefix");
    assert.match(receipt.recoveryAction, /capture-prefix/);
    assert.equal((await operation.get()).get("quiesce.storageSha256"), storageDigest);
    const probesBeforeRetry = probes;
    assert.deepEqual(await coordinator.confirmQuiesced(input), receipt);
    assert.equal(probes, probesBeforeRetry);
    const destination = db.collection("vmRuntimes_v2").doc(workspaceId);
    await destination.create({ownerUid});
    await assert.rejects(coordinator.abort(input), {publicMessage: "vm_migration_authority_changed"});
    assert.equal((await workspaceFence.get()).exists, true);
    assert.equal((await prefix.get()).exists, true);
    await destination.delete();
    assert.equal((await coordinator.abort(input)).phase, "aborted");
    assert.equal((await workspaceFence.get()).exists, false);
    assert.equal((await prefix.get()).exists, false);
  } finally {
    await app.delete();
  }
});

test("abort cannot release fences until an imported destination disk is cleaned", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = admin.initializeApp({projectId: "demo-mapache-cutover"}, randomUUID());
  try {
    const db = app.firestore();
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const bucket = "fixture-bucket";
    const source = db.collection("workspaces").doc(workspaceId);
    await source.create({ownerUid, bucket, storagePrefix: `workspaces/${ownerUid}/staging`, agentRuntimeGeneration: 7});
    const target = {ownerUid, workspaceId};
    const {observationSha256} = await createVmMigrationPreflight({db})(target);
    const input = {...target, operationId: "cleanup-destination", observationSha256};
    const digest = "a".repeat(64);
    const destinationBase = {zone: "us-central1-a", region: "us-central1", generation: 1,
      operationId: "destination", diskId: "123"};
    const descriptor = createRuntimeDescriptor({backend: COMPUTE_ENGINE_BACKEND, ...target,
      zone: destinationBase.zone, region: destinationBase.region, generation: destinationBase.generation});
    const destination = {...destinationBase, diskName: descriptor.dataDiskName};
    let deleteCalls = 0;
    const coordinator = createVmMigrationCoordinator({db, defaultBucket: bucket, authorize: async () => true,
      inspectCompute: async () => ({recordedComputeClear: true, providerObservationSha256: digest,
        blockers: [], discovery: {scannedRegionsClear: true, evidenceSha256: "b".repeat(64)}}),
      inspectStorage: async () => ({stable: true, firstSha256: "c".repeat(64), secondSha256: "c".repeat(64), blockers: []}),
      inspectDestinationDisk: async (actual, options) => {
        assert.equal(actual.dataDiskName, descriptor.dataDiskName);
        assert.equal(options.operationId, destination.operationId);
        return {diskId: destination.diskId, diskName: destination.diskName, zone: destination.zone, lastAttachTimestamp: null};
      },
      deleteImportedDisk: async (actual, options) => {
        assert.equal(actual.dataDiskName, descriptor.dataDiskName);
        assert.deepEqual(options, {operationId: destination.operationId, diskId: destination.diskId});
        deleteCalls++;
        return {diskDeleted: true, diskId: destination.diskId};
      },
      now: () => 42,
    });
    await coordinator.reserve(input);
    await coordinator.confirmQuiesced(input);
    const operation = db.doc(`vmMigrationOperations_v2/${workspaceId}/operations/${input.operationId}`);
    await operation.update({phase: "disk-import-verified", importDestination: destination,
      diskImport: {receiptSha256: digest, diskLastAttachTimestamp: null, components: ["workspace"],
        selectedEntries: 1, verifiedAtMs: 42}, validation: {cleanedAtMs: 42}});
    const before = await coordinator.getStatus(input);
    assert.equal(before.nextAction, "cleanup-imported-disk");
    assert.equal(before.destinationDiskCleanedAtMs, null);
    await assert.rejects(coordinator.abort(input), {publicMessage: "vm_migration_disk_cleanup_required"});
    const cleaned = await coordinator.cleanupImportedDisk(input);
    assert.equal(cleaned.nextAction, "review-cutover-gates");
    assert.equal(cleaned.destinationDiskCleanedAtMs, 42);
    assert.equal(deleteCalls, 1);
    assert.deepEqual(await coordinator.cleanupImportedDisk(input), cleaned);
    assert.equal(deleteCalls, 1);
    const aborted = await coordinator.abort(input);
    assert.equal(aborted.phase, "aborted");
    assert.equal(aborted.sourceRetained, true);
  } finally {
    await app.delete();
  }
});

test("cutover review binds a live destination attestation without changing authority", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = admin.initializeApp({projectId: "demo-mapache-cutover"}, randomUUID());
  try {
    const db = app.firestore();
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const bucket = "fixture-bucket";
    const source = db.collection("workspaces").doc(workspaceId);
    await source.create({ownerUid, bucket, storagePrefix: `workspaces/${ownerUid}/staging`, agentRuntimeGeneration: 7});
    const target = {ownerUid, workspaceId};
    const {observationSha256} = await createVmMigrationPreflight({db})(target);
    const input = {...target, observationSha256, operationId: "review-cutover"};
    const receiptSha256 = "a".repeat(64);
    const destination = {zone: "us-central1-a", region: "us-central1", generation: 2,
      operationId: "destination", diskId: "123", diskName: "mapache-ws-imported"};
    const runnerImage = "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:" + "b".repeat(64);
    const coordinator = createVmMigrationCoordinator({db, defaultBucket: bucket, authorize: async () => true,
      inspectCompute: async () => ({recordedComputeClear: true, providerObservationSha256: "b".repeat(64), blockers: [],
        discovery: {scannedRegionsClear: true, evidenceSha256: "c".repeat(64)}}),
      inspectStorage: async () => ({stable: true, firstSha256: "d".repeat(64), secondSha256: "d".repeat(64), blockers: []}),
      inspectDestinationRuntime: async ({record}) => ({schemaVersion: 1, workspaceId, ownerUid,
        migrationOperationId: record.operationId, destinationOperationId: destination.operationId,
        sourceGeneration: record.sourceGeneration, destinationGeneration: destination.generation,
        diskId: destination.diskId, diskName: destination.diskName, diskReceiptSha256: receiptSha256,
        sessionId: "vm-destination-session", runtime: {state: "active", generation: destination.generation,
          runnerImage, gatewayHost: "gateway.example.com", health: {path: "/runner/health", status: 200, agentReady: true},
          disk: {diskId: destination.diskId, diskName: destination.diskName, attached: true, instanceReady: true}}}),
    });
    await coordinator.reserve(input);
    await coordinator.confirmQuiesced(input);
    await db.doc(`vmMigrationOperations_v2/${workspaceId}/operations/${input.operationId}`).update({
      phase: "disk-import-verified", importDestination: destination,
      diskImport: {receiptSha256, verifiedAtMs: 42}, validation: {cleanedAtMs: 42},
    });
    const review = await coordinator.reviewCutoverGates(input);
    assert.equal(review.runtimeAttested, true);
    assert.equal(review.readyForCutover, true);
    assert.deepEqual(review.blockers, []);
    assert.equal(review.sourceAuthority, "legacy");
    assert.equal((await db.doc(`vmRuntimes_v2/${workspaceId}`).get()).exists, false);
    assert.equal((await source.get()).get("agentRuntimeGeneration"), 7);
  } finally {
    await app.delete();
  }
});

test("authority switch atomically hides the legacy source and exposes the verified VM", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = admin.initializeApp({projectId: "demo-mapache-cutover"}, randomUUID());
  try {
    const db = app.firestore();
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const bucket = "fixture-bucket";
    const source = db.collection("workspaces").doc(workspaceId);
    await source.create({ownerUid, bucket, storagePrefix: `workspaces/${ownerUid}/staging`, agentRuntimeGeneration: 7,
      agentRuntimeAuthorityState: "released"});
    const target = {ownerUid, workspaceId};
    const {observationSha256} = await createVmMigrationPreflight({db})(target);
    const input = {...target, observationSha256, operationId: "switch-authority"};
    const receiptSha256 = "a".repeat(64);
    const destination = {zone: "us-central1-a", region: "us-central1", generation: 2,
      operationId: "destination", diskId: "123", diskName: "mapache-ws-imported"};
    const sessionId = "vm-destination-session";
    const gatewayHost = "gateway.example.com";
    const runnerImage = "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:" + "b".repeat(64);
    const runtimeEvidence = {schemaVersion: 1, workspaceId, ownerUid, migrationOperationId: input.operationId,
      destinationOperationId: destination.operationId, sourceGeneration: 7, destinationGeneration: 2,
      diskId: destination.diskId, diskName: destination.diskName, diskReceiptSha256: receiptSha256, sessionId,
      runtime: {state: "active", generation: 2, runnerImage, gatewayHost,
        health: {path: "/runner/health", status: 200, agentReady: true},
        disk: {diskId: destination.diskId, diskName: destination.diskName, attached: true, instanceReady: true}}};
    const coordinator = createVmMigrationCoordinator({db, defaultBucket: bucket, authorize: async () => true,
      inspectCompute: async () => ({recordedComputeClear: true, providerObservationSha256: "b".repeat(64), blockers: [],
        discovery: {scannedRegionsClear: true, evidenceSha256: "c".repeat(64)}}),
      inspectStorage: async () => ({stable: true, firstSha256: "d".repeat(64), secondSha256: "d".repeat(64), blockers: []}),
      inspectDestinationRuntime: async () => runtimeEvidence,
      inspectDestinationRollback: async () => ({schemaVersion: 1, workspaceId, ownerUid,
        migrationOperationId: input.operationId, destinationGeneration: 2,
        diskId: destination.diskId, diskName: destination.diskName, sessionId,
        runtime: {state: "stopped", instanceAbsent: true,
          disk: {diskId: destination.diskId, diskName: destination.diskName, attached: false}},
        registry: {apiEnabled: false, state: "stopping", generation: 2, currentSessionId: sessionId},
        session: {state: "stopping", generation: 2},
        route: {enabled: false, generation: 2, sessionId}}),
      now: () => 99,
    });
    await coordinator.reserve(input);
    await coordinator.confirmQuiesced(input);
    await db.doc(`vmMigrationOperations_v2/${workspaceId}/operations/${input.operationId}`).update({
      phase: "disk-import-verified", importDestination: destination,
      diskImport: {receiptSha256, verifiedAtMs: 42}, validation: {cleanedAtMs: 42},
    });
    await db.doc(`vmRuntimes_v2/${workspaceId}`).create({ownerUid, backend: "compute-engine", apiEnabled: false,
      state: "active", generation: 2, currentSessionId: sessionId, gatewayHost, runnerImage});
    await db.doc(`vmRuntimes_v2/${workspaceId}/sessions/${sessionId}`).create({ownerUid, state: "active", generation: 2});
    await db.doc(`vmGatewayRoutes_v2/${gatewayHost}`).create({ownerUid, workspaceId, generation: 2, sessionId, enabled: true});

    const destinationRef = db.doc(`vmRuntimes_v2/${workspaceId}`);
    await destinationRef.update({apiEnabled: true});
    await assert.rejects(coordinator.switchAuthority(input), {publicMessage: "vm_migration_destination_authority_changed"});
    assert.equal((await source.get()).get("migrationAuthority"), undefined);
    assert.equal((await db.doc(`vmMigrationFences_v2/${workspaceId}`).get()).get("authority"), undefined);
    await destinationRef.update({apiEnabled: false});
    const switched = await coordinator.switchAuthority(input);
    assert.equal(switched.phase, "authority-switched");
    assert.equal(switched.authority, "destination");
    assert.equal(switched.authoritySwitchedAtMs, 99);
    assert.equal(switched.sourceRetained, true);
    assert.equal((await source.get()).get("migrationAuthority"), "compute-engine");
    assert.equal((await source.get()).get("agentRuntimeSessionId"), null);
    assert.equal((await db.doc(`vmRuntimes_v2/${workspaceId}`).get()).get("apiEnabled"), true);
    assert.equal((await db.doc(`vmMigrationFences_v2/${workspaceId}`).get()).get("authority"), "destination");
    assert.equal((await db.doc(`vmMigrationOperations_v2/${workspaceId}/operations/${input.operationId}`).get()).get("phase"), "authority-switched");
    assert.equal(switched.nextAction, "reconcile-source");
    const reconciled = await coordinator.reconcileSource(input);
    assert.equal(reconciled.sourceReconciledAtMs, 99);
    assert.equal(reconciled.nextAction, null);
    assert.equal(reconciled.recoveryAction.includes("Retain the legacy source"), true);
    assert.equal((await db.doc(`vmMigrationOperations_v2/${workspaceId}/operations/${input.operationId}`).get()).get("sourceReconciliation.state"), "verified");
    assert.deepEqual(await coordinator.reconcileSource(input), reconciled);
    assert.deepEqual(await coordinator.switchAuthority(input), reconciled);

    const draining = await coordinator.beginRollback(input);
    assert.equal(draining.phase, "rollback-draining");
    assert.equal(draining.nextAction, "complete-rollback");
    assert.equal((await source.get()).get("migrationAuthority"), "compute-engine");
    assert.equal((await destinationRef.get()).get("apiEnabled"), false);
    assert.equal((await db.doc(`vmGatewayRoutes_v2/${gatewayHost}`).get()).get("enabled"), false);
    const sourceObservationSha256 = (await createVmMigrationPreflight({db})({workspaceId, ownerUid})).sourceObservationSha256;
    await assert.rejects(coordinator.completeRollback({...input, reverseImport: {
      version: 1, state: "verified", format: "old-checkpoint-flip", operationId: input.operationId,
      sourceGeneration: 7, destinationGeneration: 2, sha256: "e".repeat(64), sourceObservationSha256,
    }}), {publicMessage: "vm_migration_reverse_import_unverified"});
    await assert.rejects(coordinator.completeRollback({...input, reverseImport: {
      version: 1, state: "verified", format: "mapache-reverse-import-v1", operationId: input.operationId,
      sourceGeneration: 7, destinationGeneration: 2, sha256: "e".repeat(64), sourceObservationSha256: "f".repeat(64),
    }}), {publicMessage: "vm_migration_reverse_import_stale"});
    const rolledBack = await coordinator.completeRollback({...input, reverseImport: {
      version: 1, state: "verified", format: "mapache-reverse-import-v1", operationId: input.operationId,
      sourceGeneration: 7, destinationGeneration: 2, sha256: "e".repeat(64), sourceObservationSha256,
    }});
    assert.equal(rolledBack.phase, "rolled-back");
    assert.equal(rolledBack.authority, "legacy");
    assert.equal(rolledBack.rollbackState, "source-restored");
    assert.equal(rolledBack.nextAction, null);
    assert.equal((await source.get()).get("migrationAuthority"), "legacy");
    assert.equal((await destinationRef.get()).get("state"), "stopped");
    assert.equal((await destinationRef.get()).get("migrationAuthority"), "legacy");
    assert.equal((await db.doc(`vmMigrationFences_v2/${workspaceId}`).get()).exists, false);
    assert.equal((await db.doc(`vmMigrationStorageFences_v2/${bucket}/owners/${ownerUid}/prefixes/staging`).get()).exists, false);
    assert.deepEqual(await coordinator.completeRollback({...input, reverseImport: {
      version: 1, state: "verified", format: "mapache-reverse-import-v1", operationId: input.operationId,
      sourceGeneration: 7, destinationGeneration: 2, sha256: "e".repeat(64), sourceObservationSha256,
    }}), rolledBack);
  } finally {
    await app.delete();
  }
});

test("legacy IAM repair remains visible to preflight while a VM fence prevents a second repair", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = admin.initializeApp({projectId: "demo-mapache-cutover"}, randomUUID());
  const providerStarted = Promise.withResolvers();
  const releaseProvider = Promise.withResolvers();
  let repair;
  try {
    const db = app.firestore();
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const projectId = "demo-mapache-cutover";
    const projectNumber = "1234567890";
    const bucketName = deriveWorkspaceBucketName(projectNumber, workspaceId);
    const source = db.collection("workspaces").doc(workspaceId);
    await source.create({ownerUid, sharedStorage: {bucketName, projectId, projectNumber, storageGeneration: "fixture"}});
    const bucketMetadata = {
      name: bucketName, project: projectId, projectNumber, location: "US-CENTRAL1", storageClass: "STANDARD",
      labels: {"mapache-workspace-id": workspaceId, "mapache-owner-uid": ownerUid},
      hierarchicalNamespace: {enabled: true},
      iamConfiguration: {uniformBucketLevelAccess: {enabled: true}, publicAccessPrevention: "enforced"},
      softDeletePolicy: {retentionDurationSeconds: 604800},
    };
    let iamCalls = 0;
    const sharedStorage = createWorkspaceSharedStorageService({
      db, storage: {bucket: () => ({getMetadata: async () => [bucketMetadata]})},
      bucketAccessService: {ensureRunnerObjectAccess: async () => {
        iamCalls++;
        providerStarted.resolve();
        await releaseProvider.promise;
      }},
    });
    const probe = () => createVmMigrationPreflight({db})({workspaceId, ownerUid});
    const initial = await probe();
    repair = sharedStorage.validateExistingWorkspaceSharedStorage(ownerUid, workspaceId);
    await Promise.race([providerStarted.promise, repair]);
    const pending = await probe();
    assert.ok(pending.blockers.includes("legacy_shared_storage_iam_unresolved"));
    assert.notEqual(pending.observationSha256, initial.observationSha256);

    await db.collection("vmMigrationFences_v2").doc(workspaceId).create({ownerUid, operationId: "fixture"});
    await assert.rejects(sharedStorage.validateExistingWorkspaceSharedStorage(ownerUid, workspaceId),
        {publicMessage: "workspace_vm_migration_active"});
    assert.equal(iamCalls, 1);
    releaseProvider.resolve();
    await repair;
    const drained = await probe();
    assert.ok(drained.blockers.includes("migration_fence_already_exists"));
    assert.ok(!drained.blockers.includes("legacy_shared_storage_iam_unresolved"));
  } finally {
    releaseProvider.resolve();
    await repair?.catch(() => {});
    await app.delete();
  }
});

test("reserved workspace stays listable while legacy metadata and settings remain frozen", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = admin.initializeApp({projectId: "demo-mapache-cutover"}, randomUUID());
  try {
    const db = app.firestore();
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const defaultBucket = "fixture-bucket";
    const workspace = db.collection("workspaces").doc(workspaceId);
    const session = workspace.collection("sessions").doc("stopped");
    await workspace.create({ownerUid, name: "Original", bucket: defaultBucket,
      storagePrefix: `workspaces/${ownerUid}/staging`, canonicalSessionId: "missing"});
    await session.create({ownerUid, runtimeKind: "main", status: "stopped"});
    const settings = createWorkspaceService({db, admin});
    const machine = createMachineConfigurationService({db, admin});
    const initialConfig = await machine.updateConfiguration(ownerUid, workspaceId, {description: "pending"});
    const target = {ownerUid, workspaceId};
    const probe = createVmMigrationPreflight({db});
    const {observationSha256} = await probe(target);
    const args = {...target, observationSha256, operationId: "metadata"};
    const coordinator = createVmMigrationCoordinator({db, defaultBucket, authorize: async () => true});
    await coordinator.reserve(args);
    const frozenDigest = (await probe(target)).observationSha256;
    const listed = await settings.listWorkspaces(ownerUid);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].canonicalSessionId, "missing");
    const rename = {name: "Renamed", resources: {sizeKey: "medium"}};
    await assert.rejects(settings.renameWorkspace(ownerUid, workspaceId, rename),
        {publicMessage: "workspace_vm_migration_active"});
    await assert.rejects(settings.saveWorkspaceMcpConfig(ownerUid, workspaceId, {}),
        {publicMessage: "workspace_vm_migration_active"});
    await assert.rejects(machine.updateConfiguration(ownerUid, workspaceId, {description: "blocked"}),
        {publicMessage: "workspace_vm_migration_active"});
    assert.deepEqual(await machine.markApplied(workspaceId, 1), initialConfig);
    assert.equal((await probe(target)).observationSha256, frozenDigest);

    await coordinator.abort(args);
    assert.equal((await settings.listWorkspaces(ownerUid))[0].canonicalSessionId, session.id);
    const renamed = await settings.renameWorkspace(ownerUid, workspaceId, rename);
    assert.equal(renamed.name, "Renamed");
    assert.deepEqual((await session.get()).get("resources"), renamed.resources);
    await settings.saveWorkspaceMcpConfig(ownerUid, workspaceId, {});
    assert.equal((await workspace.get()).get("mcpConfig.version"), 1);
    assert.equal((await machine.markApplied(workspaceId, 1)).appliedVersion, 1);
  } finally {
    await app.delete();
  }
});

test("an in-flight legacy restore blocks maintenance release and remains visible after fencing", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = admin.initializeApp({projectId: "demo-mapache-cutover"}, randomUUID());
  const providerStarted = Promise.withResolvers();
  const providerDone = Promise.withResolvers();
  let restore;
  try {
    const db = app.firestore();
    const projectId = "demo-mapache-cutover";
    const projectNumber = "1234567890";
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const bucketName = deriveWorkspaceBucketName(projectNumber, workspaceId);
    const workspace = db.collection("workspaces").doc(workspaceId);
    await workspace.create({ownerUid, sharedStorage: {bucketName, projectId, projectNumber}});
    const object = {
      name: "fixture.txt",
      metadata: {generation: "1", timeDeleted: "2026-01-01T01:00:00.000Z", size: "1"},
      restore: async () => {
        providerStarted.resolve();
        await providerDone.promise;
        return {generation: "2", size: "1"};
      },
    };
    const storage = {bucket: () => ({
      getMetadata: async () => [{
        name: bucketName, project: projectId, projectNumber, location: "US-CENTRAL1", storageClass: "STANDARD",
        labels: {"mapache-workspace-id": workspaceId, "mapache-owner-uid": ownerUid},
        hierarchicalNamespace: {enabled: true}, versioning: {enabled: false},
        iamConfiguration: {uniformBucketLevelAccess: {enabled: true}, publicAccessPrevention: "enforced"},
        softDeletePolicy: {retentionDurationSeconds: 604800},
      }],
      getFiles: async () => [[object], null],
    })};
    const backup = createWorkspaceStorageBackupService({db, admin, storage, projectId, now: () => new Date("2026-01-02")});
    const {reservationId} = await backup.acquireMaintenanceReservation(ownerUid, workspaceId);
    const restoreObject = () => backup.restoreGeneration(ownerUid, workspaceId, reservationId, {objectPath: object.name, generation: "1"});
    restore = restoreObject();
    await Promise.race([providerStarted.promise, restore]);
    const probe = () => createVmMigrationPreflight({db})({workspaceId, ownerUid});
    const unresolved = "legacy_storage_recovery_write_unresolved";
    assert.ok((await probe()).blockers.includes(unresolved));
    await db.collection("vmMigrationFences_v2").doc(workspaceId).create({ownerUid, operationId: "fixture"});
    await assert.rejects(backup.releaseMaintenanceReservation(ownerUid, workspaceId, reservationId),
        {publicMessage: "workspace_recovery_write_unresolved"});
    await assert.rejects(restoreObject(), {publicMessage: "workspace_vm_migration_active"});
    providerDone.resolve();
    assert.equal((await restore).restoredGeneration, "2");
    assert.ok(!(await probe()).blockers.includes(unresolved));
    assert.ok((await probe()).blockers.includes("legacy_storage_recovery_reservation_unresolved"));
    await backup.releaseMaintenanceReservation(ownerUid, workspaceId, reservationId);
    assert.ok(!(await probe()).blockers.includes("legacy_storage_recovery_reservation_unresolved"));
  } finally {
    providerDone.resolve();
    await restore?.catch(() => {});
    await app.delete();
  }
});

test("migration detects a pre-fence scheduler lease and denies its subsequent Cloud Run stop", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const app = admin.initializeApp({projectId: "demo-mapache-cutover"}, randomUUID());
  const stopRequested = Promise.withResolvers();
  const continueStop = Promise.withResolvers();
  let reconcile;
  try {
    const db = app.firestore();
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const defaultBucket = "fixture-bucket";
    const workspace = db.collection("workspaces").doc(workspaceId);
    const sessionCollection = () => workspace.collection("sessions");
    const session = sessionCollection().doc("main");
    await workspace.create({ownerUid, bucket: defaultBucket, storagePrefix: `workspaces/${ownerUid}/staging`,
      canonicalSessionId: session.id, runtimeScheduleStatus: "open", runtimePolicyRevision: 1,
      runtimePolicy: {mode: "scheduled", schedule: {days: [1], startTime: "08:00", endTime: "18:00", timezone: "UTC"}}});
    await session.create({ownerUid, runtimeKind: "main", status: "running"});
    let stopCalls = 0;
    const lifecycle = createSessionLifecycleService({db, admin, sessionCollection,
      requireWorkspace: async () => (await workspace.get()).data(),
      now: () => new Date("2026-10-19T19:00:00.000Z"),
      deleteSessionService: async () => { stopCalls++; return true; }});
    const scheduler = createWorkspaceRuntimeScheduleService({db, admin, sessionCollection,
      stopSessionForSchedule: async (...args) => {
        stopRequested.resolve();
        await continueStop.promise;
        return lifecycle.stopSessionForSchedule(...args);
      }});
    reconcile = scheduler.reconcileWorkspace(workspaceId, new Date("2026-10-19T19:00:00.000Z"));
    await Promise.race([stopRequested.promise, reconcile]);
    const target = {ownerUid, workspaceId};
    const probe = () => createVmMigrationPreflight({db})(target);
    const leaseBlocker = "legacy_runtime_schedule_lease_unresolved";
    const before = await probe();
    assert.ok(before.blockers.includes(leaseBlocker), "lease is visible even past its scheduler TTL");
    const coordinator = createVmMigrationCoordinator({db, defaultBucket, authorize: async () => true});
    const args = {...target, observationSha256: before.observationSha256, operationId: "scheduled-stop"};
    assert.equal((await coordinator.reserve(args)).phase, "reserved");
    const skipped = await scheduler.reconcileWorkspace(workspaceId, new Date("2026-10-19T23:00:00.000Z"));
    assert.equal(skipped.reason, "workspace_vm_migration_active");
    continueStop.resolve();
    assert.equal((await reconcile).reason, "workspace_vm_migration_active");
    assert.equal(stopCalls, 0);
    assert.equal((await session.get()).get("status"), "running");
    assert.equal((await workspace.get()).get("runtimeScheduleStatus"), "open");
    assert.ok(!(await probe()).blockers.includes(leaseBlocker));
  } finally {
    continueStop.resolve();
    await reconcile?.catch(() => {});
    await app.delete();
  }
});

test("prefix capture binds immutable object generations to the fenced quiesce receipt", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async t => {
  const app = admin.initializeApp({projectId: "demo-mapache-cutover"}, randomUUID());
  try {
    const db = app.firestore();
    const ownerUid = "owner-" + randomUUID();
    const workspaceId = "workspace-" + randomUUID();
    const bucket = "fixture-bucket";
    const prefix = `workspaces/${ownerUid}/staging`;
    const workspace = db.collection("workspaces").doc(workspaceId);
    const storagePrefix = prefix + "/.mapache-internal/agent-snapshots/v1";
    const base = storagePrefix + "/workspace-files/7/boot/capture";
    const filePath = base + "/objects/file.txt";
    const manifestPath = base + "/manifest.json";
    const digest = content => createHash("sha256").update(content).digest("hex");
    const file = Buffer.from("verified checkpoint");
    const manifest = Buffer.from(JSON.stringify({manifestVersion: 1, kind: "mapache-workspace-file-state",
      workspaceId, sessionId: "fixture-main", generation: 7, bootInstanceId: "boot", storagePrefix,
      files: [{kind: "workspace-file", path: "file.txt", objectPath: filePath, byteLength: file.length, mode: 0o640,
        sha256: digest(file)}], tombstones: []}));
    const checkpoint = {generation: 7, bootInstanceId: "boot",
      manifest: {bucketName: bucket, objectPath: manifestPath, byteLength: manifest.length, sha256: digest(manifest)}};
    async function archive(bytes) {
      const pack = tar.pack();
      pack.entry({name: "fixture.txt", mode: 0o640}, bytes);
      pack.finalize();
      const chunks = [];
      for await (const chunk of pack) chunks.push(chunk);
      return gzipSync(Buffer.concat(chunks));
    }
    const home = "verified HOME";
    const profile = "verified browser profile";
    const contents = new Map([[manifestPath, manifest], [filePath, file],
      [prefix + "/.mapache-internal/home/home.tar.gz", await archive(home)],
      [prefix + "/.mapache-internal/chrome/chrome-profile.tar.gz", await archive(profile)]]);
    const checksum = content => {
      const crc = new CRC32C();
      crc.update(content);
      return crc.toString();
    };
    await workspace.create({ownerUid, bucket, storagePrefix: prefix, agentRuntimeGeneration: 7, homePolicy: {mode: "persistent"},
      agentRuntimeWorkspaceFiles: checkpoint});
    await workspace.collection("sessions").doc("fixture-main").create({ownerUid, runtimeKind: "main", status: "stopped"});
    await workspace.collection("sessions").doc("fixture-background").create({ownerUid, runtimeKind: "automation", status: "stopped"});
    const operation = db.doc(`vmMigrationOperations_v2/${workspaceId}/operations/capture`);
    const chunks = operation.collection("prefixInventory");
    const prefixFence = db.doc(`vmMigrationStorageFences_v2/${bucket}/owners/${ownerUid}/prefixes/staging`);
    let generation = "100";
    let changeOperationDuringRead = false;
    const initialDiskId = "9007199254740993";
    let diskId = initialDiskId;
    let diskLastAttachTimestamp;
    let cloneDiskId = "9007199254740997";
    let changeDuringClone = false;
    let cleanupCalls = 0;
    let receiptFile;
    let substituteEvidence = false;
    let changeDuringEvidence = false;
    const inspectStorage = createVmMigrationStorageObserver({defaultBucket: bucket, listPage: async () => ({
      objects: [
        ...Array.from({length: 70}, (_, index) => ({name: `${prefix}/private-${index.toString().padStart(2, "0")}`,
          generation, metageneration: "1", size: "8", crc32c: "valid"})),
        ...[...contents].map(([name, content]) => ({name, generation, metageneration: "1", size: String(content.length), crc32c: checksum(content)})),
      ],
    })});
    const coordinator = createVmMigrationCoordinator({db, defaultBucket: bucket, authorize: async () => true, inspectStorage,
      inspectDestinationDisk: async (descriptor, {operationId}) => {
        assert.equal(operationId, "destination");
        return {diskId, diskName: descriptor.dataDiskName, zone: descriptor.zone, lastAttachTimestamp: diskLastAttachTimestamp};
      },
      ensureValidationClone: async (descriptor, options) => {
        assert.equal(descriptor.dataDiskName, receiptDestinationDiskName);
        assert.equal(options.sourceDiskId, initialDiskId);
        if (changeDuringClone) await operation.update({changedDuringClone: true});
        return {cloneDiskId, cloneDiskName: options.cloneDiskName, sourceDiskId: options.sourceDiskId};
      },
      startValidationVm: async (descriptor, options) => {
        assert.match(descriptor.instanceName, /^mapache-val-vm-[a-f0-9]{24}$/);
        assert.equal(options.sessionId, descriptor.instanceName.replace("mapache-val-vm-", "validation-"));
        assert.equal(options.cloneDiskId, "9007199254740997");
        assert.equal(options.sourceDiskId, initialDiskId);
        assert.deepEqual(Object.keys(options.credentials).sort(), ["browserToken", "controlToken", "shutdownToken"]);
        return {instanceId: "9007199254740999", instanceName: descriptor.instanceName, cloneDiskId: options.cloneDiskId};
      },
      deleteValidationResources: async (descriptor, options) => {
        cleanupCalls++;
        assert.match(descriptor.dataDiskName, /^mapache-val-disk-[a-f0-9]{24}$/);
        assert.equal(options.cloneDiskId, "9007199254740997");
        assert.equal(options.sourceDiskId, initialDiskId);
        return {instanceDeleted: true, diskDeleted: true};
      },
      readDiskImportEvidence: async ({destination}) => {
        assert.equal(destination.diskId, initialDiskId);
        if (changeDuringEvidence) await operation.update({changedDuringVerification: true});
        const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
        return {diskId: initialDiskId, receipt: substituteEvidence ? {...receipt, prefixCapture: {...receipt.prefixCapture, sha256: "c".repeat(64)}} : receipt};
      },
      inspectCompute: async () => {
        if (changeOperationDuringRead) await operation.update({concurrentChange: true});
        return {recordedComputeClear: true, providerObservationSha256: "a".repeat(64), blockers: [],
          discovery: {scannedRegionsClear: true, evidenceSha256: "b".repeat(64)}};
      },
    });
    const source = {workspaceId, ownerUid};
    const {observationSha256} = await createVmMigrationPreflight({db})(source);
    const input = {...source, operationId: "capture", observationSha256};
    await coordinator.reserve(input);
    await assert.rejects(coordinator.capturePrefix(input), {publicMessage: "vm_migration_prefix_capture_phase_invalid"});
    await coordinator.confirmQuiesced(input);
    generation = "101";
    await assert.rejects(coordinator.capturePrefix(input), {publicMessage: "vm_migration_prefix_capture_provider_changed"});
    generation = "100";
    changeOperationDuringRead = true;
    await assert.rejects(coordinator.capturePrefix(input), {publicMessage: "vm_migration_prefix_capture_stale"});
    assert.equal((await chunks.get()).size, 0);
    changeOperationDuringRead = false;
    const captured = await coordinator.capturePrefix(input);
    assert.equal(captured.phase, "prefix-captured");
    assert.equal(captured.prefixCapturedObjects, 74);
    assert.equal(captured.readyForCutover, false);
    assert.ok(!JSON.stringify(captured).includes("private-"));
    assert.deepEqual(await coordinator.capturePrefix(input), captured);
    assert.equal((await chunks.get()).size, 2);
    const inventory = await coordinator.getCapturedPrefix(input);
    assert.equal(inventory.operationId, input.operationId);
    assert.equal(inventory.sourceGeneration, 7);
    assert.deepEqual(inventory.checkpointPointers, {workspace: checkpoint, agent: null});
    assert.deepEqual(inventory.mainSessionIds, ["fixture-main"]);
    assert.equal(inventory.rows.length, 74);
    assert.deepEqual(inventory.rows.find(([name]) => name === `${prefix}/private-00`),
        [`${prefix}/private-00`, ["100", "1", "8", "valid"]]);
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-capture-emulator-"));
    t.after(() => fs.rm(folder, {recursive: true, force: true}));
    const root = path.join(folder, "stage");
    const {importCapturedCheckpoint} = await import("../scripts/lib/vm-captured-checkpoint-import.mjs");
    const {importCapturedArchive} = await import("../scripts/lib/vm-captured-archive-import.mjs");
    const {assembleMergedImport} = await import("../scripts/lib/vm-import-merge.mjs");
    const readGenerations = [];
    const storage = {bucket: name => {
      assert.equal(name, bucket);
      return {file: (name, options) => {
        readGenerations.push(options.generation);
        const content = contents.get(name);
        return {getMetadata: async () => [{name, generation: "100", metageneration: "1", size: String(content.length),
          crc32c: checksum(content)}], createReadStream: () => Readable.from([content])};
      }};
    }};
    const readCapture = coordinator.getCapturedPrefix;
    const imported = await importCapturedCheckpoint({input, kind: "workspace", root, maxBytes: 4096, readCapture, storage});
    assert.equal(imported.captureSha256, inventory.sha256);
    const sources = [{kind: "checkpoint", root, planFile: path.join(root, "checkpoint-plan.json")}];
    for (const kind of ["home", "browser"]) {
      const archiveRoot = path.join(folder, kind);
      const archive = await importCapturedArchive({input, kind, root: archiveRoot, readCapture, storage,
        maxCompressedBytes: 4096, maxExpandedBytes: 4096, maxEntries: 20});
      assert.equal(archive.captureSha256, inventory.sha256);
      sources.push({kind: "archive", root: archiveRoot});
    }
    assert.deepEqual(readGenerations, ["100", "100", "100", "100"]);
    const mergedRoot = path.join(folder, "merged");
    const merged = await assembleMergedImport({root: mergedRoot, ownerUid, workspaceId, operationId: input.operationId,
      sources, maxBytes: 4096,
      prefixCapture: {operationId: input.operationId, sha256: inventory.sha256, sourceGeneration: inventory.sourceGeneration}});
    assert.equal(merged.files, 3);
    assert.deepEqual(merged.prefixCapture.components, ["browser", "home", "workspace"]);
    assert.deepEqual(await fs.readFile(path.join(mergedRoot, "tree/workspace/file.txt")), file);
    assert.equal(await fs.readFile(path.join(mergedRoot, "tree/home/fixture.txt"), "utf8"), home);
    assert.equal(await fs.readFile(path.join(mergedRoot, "tree/browser/profile/fixture.txt"), "utf8"), profile);
    const destination = {zone: "us-central1-a", generation: 1, operationId: "destination"};
    await assert.rejects(coordinator.verifyDiskImport(input), {publicMessage: "vm_migration_disk_destination_unregistered"});
    await coordinator.registerImportDisk({...input, destination});
    await coordinator.registerImportDisk({...input, destination});
    diskId = "9007199254740994";
    await assert.rejects(coordinator.registerImportDisk({...input, destination}), {publicMessage: "vm_migration_disk_destination_conflict"});
    diskId = initialDiskId;
    const mountRoot = path.join(folder, "disk");
    await fs.mkdir(mountRoot, {mode: 0o700});
    const {retainedDiskMarker, DISK_MARKER_NAME} = require("../session-runner/lib/retainedDiskStorage");
    await fs.writeFile(path.join(mountRoot, DISK_MARKER_NAME), JSON.stringify(retainedDiskMarker({...source, ...destination})));
    const {importToRetainedDisk} = await import("../scripts/lib/vm-disk-import.mjs");
    const receipt = await importToRetainedDisk({...source, mountRoot, generation: destination.generation,
      operationId: destination.operationId, sources, maxBytes: 4096, prefixCapture: merged.prefixCapture}, {checkMount: async () => {}});
    const receiptDestinationDiskName = receipt.destination.diskName;
    receiptFile = path.join(mountRoot, ".mapache-import-stage/disk-import-receipt.json");
    substituteEvidence = true;
    await assert.rejects(coordinator.verifyDiskImport(input), {publicMessage: "vm_migration_disk_receipt_invalid"});
    substituteEvidence = false;
    diskId = "9007199254740994";
    await assert.rejects(coordinator.verifyDiskImport(input), {publicMessage: "vm_migration_disk_identity_changed"});
    diskId = initialDiskId;
    changeDuringEvidence = true;
    await assert.rejects(coordinator.verifyDiskImport(input), {publicMessage: "vm_migration_disk_observation_stale"});
    changeDuringEvidence = false;
    const verified = await coordinator.verifyDiskImport(input);
    assert.deepEqual(await coordinator.verifyDiskImport(input), verified);
    assert.equal(verified.phase, "disk-import-verified");
    assert.deepEqual(verified.diskImportedComponents, ["browser", "home", "workspace"]);
    assert.equal(verified.readyForCutover, false);
    assert.ok(!JSON.stringify(verified).includes(initialDiskId));
    await assert.rejects(coordinator.prepareValidationClone(input), {publicMessage: "vm_migration_validation_reservation_missing"});
    const runnerImage = "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:" + "a".repeat(64);
    await assert.rejects(coordinator.reserveValidationBoot({...input, runnerImage: "latest"}),
        {publicMessage: "vm_migration_validation_image_invalid"});
    diskLastAttachTimestamp = "2026-11-23T00:00:00Z";
    await assert.rejects(coordinator.reserveValidationBoot({...input, runnerImage}),
        {publicMessage: "vm_migration_validation_source_disk_changed"});
    diskLastAttachTimestamp = undefined;
    const reserved = await coordinator.reserveValidationBoot({...input, runnerImage});
    assert.equal(typeof reserved.validationReservedAtMs, "number");
    assert.deepEqual(await coordinator.reserveValidationBoot({...input, runnerImage}), reserved);
    changeDuringClone = true;
    await assert.rejects(coordinator.prepareValidationClone(input), {publicMessage: "vm_migration_validation_observation_stale"});
    await assert.rejects(coordinator.abort(input), {publicMessage: "vm_migration_validation_cleanup_required"});
    changeDuringClone = false;
    const prepared = await coordinator.prepareValidationClone(input);
    assert.equal(typeof prepared.validationCloneVerifiedAtMs, "number");
    assert.deepEqual(await coordinator.prepareValidationClone(input), prepared);
    const booted = await coordinator.startValidationBoot(input);
    assert.equal(typeof booted.validationInstanceStartedAtMs, "number");
    const validationSessionId = (await db.collection("vmMigrationValidationRuntimes_v2").doc(workspaceId).get()).get("currentSessionId");
    const validationCredentials = await db.collection("vmMigrationValidationCredentials_v2").doc(validationSessionId).get();
    assert.equal(validationCredentials.get("ownerUid"), ownerUid);
    assert.deepEqual(Object.keys(validationCredentials.data()).sort(), ["browserToken", "controlToken", "generation", "migrationOperationId", "ownerUid", "shutdownToken"]);
    cloneDiskId = "9007199254740998";
    await assert.rejects(coordinator.prepareValidationClone(input), {publicMessage: "vm_migration_validation_clone_conflict"});
    assert.equal(prepared.readyForCutover, false);
    const cleaned = await coordinator.cleanupValidationBoot(input);
    assert.equal(typeof cleaned.validationCleanedAtMs, "number");
    assert.equal(cleaned.readyForCutover, false);
    assert.deepEqual(await coordinator.cleanupValidationBoot(input), cleaned);
    assert.equal(cleanupCalls, 1);
    assert.ok(!(await db.collection("vmRuntimes_v2").doc(workspaceId).get()).exists);
    const chunk = chunks.doc("0");
    const original = (await chunk.get()).get("rowsJson");
    await chunk.update({rowsJson: original.replace('"100"', '"101"')});
    await assert.rejects(coordinator.getCapturedPrefix(input), {publicMessage: "legacy_storage_capture_invalid"});
    await chunk.update({rowsJson: original});
    await prefixFence.update({changedAt: 1});
    await assert.rejects(coordinator.getCapturedPrefix(input), {publicMessage: "vm_migration_prefix_capture_source_changed"});
    await assert.rejects(coordinator.abort(input), {publicMessage: "vm_migration_validation_cleanup_required"});
  } finally {
    await app.delete();
  }
});
