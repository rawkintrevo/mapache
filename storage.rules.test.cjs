"use strict";

const {readFileSync} = require("node:fs");
const {initializeTestEnvironment, assertFails, assertSucceeds} = require("@firebase/rules-unit-testing");
const {doc, setDoc, deleteDoc, getDoc} = require("firebase/firestore");
const {ref, uploadString, getMetadata, deleteObject} = require("firebase/storage");

async function main() {
  const env = await initializeTestEnvironment({
    projectId: "mapache-rules-test",
    firestore: {rules: readFileSync("firestore.rules", "utf8")},
    storage: {rules: readFileSync("storage.rules", "utf8")},
  });
  try {
    const bucket = "mapache-rules-test.appspot.com";
    const alice = env.authenticatedContext("alice");
    const bob = env.authenticatedContext("bob");
    const aliceStorage = alice.storage("gs://" + bucket);
    const file = ref(aliceStorage, "workspaces/alice/primary/nested/file");
    const neighbor = ref(aliceStorage, "workspaces/alice/secondary/file");
    const fence = `vmMigrationStorageFences_v2/${bucket}/owners/alice/prefixes/primary`;

    await assertSucceeds(uploadString(file, "before freeze"));
    await assertFails(uploadString(ref(bob.storage("gs://" + bucket), file.fullPath), "foreign"));
    await assertFails(setDoc(doc(alice.firestore(), fence), {}));
    await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), fence), {}));
    await assertFails(getDoc(doc(alice.firestore(), fence)));
    await assertFails(deleteDoc(doc(alice.firestore(), fence)));
    await assertSucceeds(getMetadata(file));
    await assertFails(uploadString(file, "replace"));
    await assertFails(deleteObject(file));
    await assertFails(uploadString(ref(aliceStorage, "workspaces/alice/primary/new"), "create"));
    await assertSucceeds(uploadString(neighbor, "adjacent workspace"));
    await env.withSecurityRulesDisabled(context => deleteDoc(doc(context.firestore(), fence)));
    await assertSucceeds(uploadString(file, "after thaw"));
    await assertSucceeds(deleteObject(file));
  } finally {
    await env.cleanup();
  }
}

main().then(() => console.log("storage migration rules tests passed")).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
