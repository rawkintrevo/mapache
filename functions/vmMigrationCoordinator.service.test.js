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
