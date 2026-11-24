"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {randomUUID} = require("node:crypto");
const admin = require("firebase-admin");
const {createVmMigrationCoordinator} = require("./vmMigrationCoordinator.service");
const {createVmMigrationPreflight} = require("./vmMigrationPreflight.service");

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
    await assert.rejects(createVmMigrationCoordinator(options).confirmQuiesced(input),
        {publicMessage: "vm_migration_quiesce_unverified"});
    const pending = db.doc(`vmLegacyUploads_v2/${workspaceId}/pending/unresolved`);
    await pending.create({});
    await assert.rejects(coordinator.confirmQuiesced(input), {publicMessage: "vm_migration_writers_not_drained"});
    assert.equal(probes, 0);
    await pending.delete();

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
