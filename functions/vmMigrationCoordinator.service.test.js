"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {randomUUID} = require("node:crypto");
const admin = require("firebase-admin");
const {createVmMigrationCoordinator} = require("./vmMigrationCoordinator.service");
const {createVmMigrationPreflight} = require("./vmMigrationPreflight.service");
const {createWorkspaceSharedStorageService, deriveWorkspaceBucketName} = require("./workspaceSharedStorage.service");
const {createWorkspaceService} = require("./workspace.service");
const {createMachineConfigurationService} = require("./machineConfiguration.service");
const {createWorkspaceStorageBackupService} = require("./workspaceStorageBackup.service");
const {createWorkspaceRuntimeScheduleService} = require("./workspaceRuntimeSchedule.service");
const {createSessionLifecycleService} = require("./sessionLifecycle.service");

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
