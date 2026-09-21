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
