"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} = require("firebase/firestore");

const RULES_PATH = path.join(__dirname, "firestore.rules");
const INDEXES_PATH = path.join(__dirname, "firestore.indexes.json");

function indexFieldNames(index) {
  return index.fields.map((field) => field.fieldPath);
}

function assertIndex(indexes, collectionGroup, fields, queryScope) {
  assert.ok(indexes.some((index) => index.collectionGroup === collectionGroup &&
    index.queryScope === queryScope &&
    indexFieldNames(index).join(",") === fields.join(",")),
  `missing ${queryScope} index for ${collectionGroup}: ${fields.join(", ")}`);
}

async function seedData(testEnv) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "workspaces/workspace-a"), {
      ownerUid: "alice",
      userPath: "users/alice",
      name: "Alice workspace",
      automationMaxConcurrency: 1,
    });
    await setDoc(doc(db, "workspaces/workspace-b"), {
      ownerUid: "bob",
      userPath: "users/bob",
      name: "Bob workspace",
      automationMaxConcurrency: 1,
    });
    await setDoc(doc(db, "workspaces/workspace-a/automations/automation-a"), {
      ownerUid: "alice",
      workspaceId: "workspace-a",
      name: "Alice automation",
    });
    await setDoc(doc(db, "workspaces/workspace-b/automations/automation-b"), {
      ownerUid: "bob",
      workspaceId: "workspace-b",
      name: "Bob automation",
    });
    await setDoc(doc(db, "automationRuns/run-a"), {
      ownerUid: "alice",
      workspaceId: "workspace-a",
      automationId: "automation-a",
      status: "succeeded",
    });
    await setDoc(doc(db, "automationRuns/run-b"), {
      ownerUid: "bob",
      workspaceId: "workspace-b",
      automationId: "automation-b",
      status: "succeeded",
    });
  });
}

async function main() {
  const indexSource = fs.readFileSync(INDEXES_PATH, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const indexes = JSON.parse(indexSource);
  assertIndex(indexes.indexes, "automations", ["enabled", "deleted", "nextRunAt"], "COLLECTION_GROUP");
  assertIndex(indexes.indexes, "automationRuns", ["ownerUid", "createdAt", "__name__"], "COLLECTION");
  assertIndex(indexes.indexes, "automationRuns", ["ownerUid", "workspaceId", "createdAt"], "COLLECTION");
  assertIndex(indexes.indexes, "automationRuns", ["ownerUid", "status", "createdAt"], "COLLECTION");
  assertIndex(indexes.indexes, "automationRuns", ["workspaceId", "status", "createdAt"], "COLLECTION");
  assertIndex(indexes.indexes, "automationRuns", ["status", "cleanupState", "updatedAt"], "COLLECTION");

  const testEnv = await initializeTestEnvironment({
    projectId: "mapache-rules-test",
    firestore: {rules: fs.readFileSync(RULES_PATH, "utf8")},
  });
  try {
    await seedData(testEnv);
    const alice = testEnv.authenticatedContext("alice").firestore();
    const bob = testEnv.authenticatedContext("bob").firestore();

    await assertSucceeds(getDoc(doc(alice, "workspaces/workspace-a/automations/automation-a")));
    await assertSucceeds(getDoc(doc(alice, "automationRuns/run-a")));
    await assertFails(getDoc(doc(alice, "workspaces/workspace-b/automations/automation-b")));
    await assertFails(getDoc(doc(alice, "automationRuns/run-b")));
    await assertSucceeds(getDoc(doc(bob, "automationRuns/run-b")));
    await assertFails(getDoc(doc(bob, "automationRuns/run-a")));

    const aliceRuns = await assertSucceeds(getDocs(query(
        collection(alice, "automationRuns"), where("ownerUid", "==", "alice"))));
    assert.deepEqual(aliceRuns.docs.map((run) => run.id), ["run-a"]);

    await assertFails(setDoc(doc(alice, "workspaces/workspace-a/automations/automation-a"), {
      ownerUid: "alice",
      name: "client mutation",
    }));
    await assertFails(setDoc(doc(alice, "automationRuns/run-a"), {
      ownerUid: "alice",
      status: "failed",
    }));
    await assertFails(updateDoc(doc(alice, "workspaces/workspace-a"), {
      automationMaxConcurrency: 99,
    }));
    await assertFails(updateDoc(doc(alice, "workspaces/workspace-a"), {
      runtimePolicy: {mode: "scheduled", schedule: {days: [1], startTime: "08:00", endTime: "18:00", timezone: "UTC"}},
    }));
    await assertFails(setDoc(doc(alice, "workspaces/client-created"), {
      ownerUid: "alice",
      userPath: "users/alice",
      runtimePolicy: {mode: "scheduled", schedule: {}},
    }));

    const workspace = doc(alice, "workspaces/workspace-a");
    const ownerFields = {ownerUid: "alice", userPath: "users/alice", name: "Client workspace"};
    await assertSucceeds(updateDoc(workspace, {name: "Renamed"}));
    await assertFails(updateDoc(workspace, {runtimeProvider: {backend: "compute-engine"}}));
    await assertFails(updateDoc(workspace, {agentRuntimeGeneration: 9, storagePrefix: "other"}));
    await assertFails(setDoc(doc(alice, "workspaces/client-created"), {
      ...ownerFields, runtimeProviderDescriptor: {backend: "compute-engine"},
    }));
    await assertSucceeds(setDoc(doc(alice, "workspaces/client-created"), ownerFields));
    await assertSucceeds(deleteDoc(doc(alice, "workspaces/client-created")));

    const fence = doc(alice, "vmMigrationFences_v2/workspace-a");
    await assertFails(setDoc(fence, {}));
    await testEnv.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), fence.path), {});
      await setDoc(doc(context.firestore(), "vmMigrationFences_v2/fenced-missing"), {});
    });
    await assertFails(getDoc(fence));
    await assertFails(deleteDoc(fence));
    await assertSucceeds(getDoc(workspace));
    await assertFails(updateDoc(workspace, {name: "During import"}));
    await assertFails(deleteDoc(workspace));
    await assertFails(setDoc(doc(alice, "workspaces/fenced-missing"), ownerFields));
    await testEnv.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await updateDoc(doc(db, workspace.path), {runtimeProvider: {backend: "compute-engine"}});
      await deleteDoc(doc(db, fence.path));
    });
    await assertSucceeds(updateDoc(workspace, {name: "After import"}));
    await assertFails(updateDoc(workspace, {runtimeProvider: deleteField()}));
    await assertFails(deleteDoc(workspace));
  } finally {
    await testEnv.cleanup();
  }
}

main().then(() => {
  console.log("firestore rules tests passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
