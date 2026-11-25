#!/usr/bin/env node
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const flags = new Set(["--project", "--workspace", "--owner", "--operation", "--confirm"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PROJECT = "pi-agents-cloud";
const DEFAULT_BUCKET = "pi-agents-cloud.firebasestorage.app";

function parseOptions() {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const [flag, value] = process.argv.slice(index, index + 2);
    if (!flags.has(flag) || !value || options.has(flag)) throw Error("source_reconciliation_arguments_invalid");
    options.set(flag, value);
  }
  if (options.size !== flags.size || options.get("--project") !== PROJECT ||
      options.get("--confirm") !== "source-reconciliation" ||
      !["--workspace", "--owner", "--operation"].every(flag => IDENTIFIER.test(options.get(flag) || ""))) {
    throw Error("source_reconciliation_arguments_invalid");
  }
  return options;
}

try {
  const options = parseOptions();
  const admin = require("../functions/node_modules/firebase-admin");
  const {GoogleAuth} = require("../functions/node_modules/google-auth-library");
  const {Storage} = require("../functions/node_modules/@google-cloud/storage");
  const {createVmLegacyComputeObserver} = require("../functions/vmLegacyComputeObservation.service.js");
  const {createVmMigrationCoordinator} = require("../functions/vmMigrationCoordinator.service.js");
  const {createVmMigrationStorageObserver} = require("../functions/vmMigrationStorageObservation.service.js");
  const app = admin.initializeApp({projectId: PROJECT}, "vm-migration-source-reconciliation");
  const db = app.firestore();
  const auth = new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]});
  const storage = new Storage({projectId: PROJECT});
  const inspectCompute = createVmLegacyComputeObserver({auth, projectId: PROJECT, projectNumber: "299764728235",
    defaultRegion: "us-central1", defaultBucket: DEFAULT_BUCKET});
  const inspectStorage = createVmMigrationStorageObserver({defaultBucket: DEFAULT_BUCKET,
    listPage: async ({bucketName, ...query}) => {
      const [, , response] = await storage.bucket(bucketName).getFiles({...query, autoPaginate: false,
        fields: "nextPageToken,items(name,generation,metageneration,size,crc32c)"});
      return {objects: response.items || [], nextPageToken: response.nextPageToken};
    }});
  const input = {workspaceId: options.get("--workspace"), ownerUid: options.get("--owner"), operationId: options.get("--operation")};
  try {
    const coordinator = createVmMigrationCoordinator({db, inspectCompute, inspectStorage, defaultBucket: DEFAULT_BUCKET,
      authorize: async (_, action) => action === "reconcile-source"});
    console.log(JSON.stringify(await coordinator.reconcileSource(input)));
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === "string" && /^(?:source_reconciliation_|vm_migration_|runtime_migration_|runtime_data_|compute_)[a-z0-9_]+$/.test(code)
    ? code : "source_reconciliation_failed";
  console.error(JSON.stringify({status: "blocked", reason, readyForCutover: false, sourceRetained: true}));
  process.exitCode = 1;
}
