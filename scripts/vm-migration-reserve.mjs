#!/usr/bin/env node
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const PROJECT = "pi-agents-cloud";
const DEFAULT_BUCKET = "pi-agents-cloud.firebasestorage.app";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FLAGS = new Set(["--project", "--workspace", "--owner", "--operation", "--confirm", "--observation-sha256"]);

function parseOptions(argv) {
  const action = argv[0];
  if (!["reserve", "quiesce"].includes(action)) throw Error("migration_reserve_action_invalid");
  const options = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const [flag, value] = argv.slice(index, index + 2);
    if (!FLAGS.has(flag) || !value || options.has(flag)) throw Error("migration_reserve_arguments_invalid");
    options.set(flag, value);
  }
  const required = ["--project", "--workspace", "--owner", "--operation", "--confirm"];
  if (!required.every(flag => options.has(flag)) || options.get("--project") !== PROJECT ||
      !["--workspace", "--owner", "--operation"].every(flag => IDENTIFIER.test(options.get(flag) || ""))) {
    throw Error("migration_reserve_arguments_invalid");
  }
  const expectedConfirmation = action === "reserve" ? "migration-reserve" : "migration-quiesce";
  if (options.get("--confirm") !== expectedConfirmation) throw Error("migration_reserve_confirmation_invalid");
  if (action === "reserve" && !DIGEST.test(options.get("--observation-sha256") || "")) {
    throw Error("migration_reserve_observation_invalid");
  }
  if (action === "quiesce" && options.has("--observation-sha256")) {
    throw Error("migration_reserve_arguments_invalid");
  }
  return {action, options};
}

function inputFrom(options) {
  return {workspaceId: options.get("--workspace"), ownerUid: options.get("--owner"), operationId: options.get("--operation")};
}

function createObservers({GoogleAuth, Storage, createVmLegacyComputeObserver, createVmMigrationStorageObserver}) {
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
  return {inspectCompute, inspectStorage};
}

try {
  const {action, options} = parseOptions(process.argv.slice(2));
  const admin = require("../functions/node_modules/firebase-admin");
  const {createVmMigrationCoordinator} = require("../functions/vmMigrationCoordinator.service.js");
  const app = admin.initializeApp({projectId: PROJECT}, "vm-migration-reserve");
  const db = app.firestore();
  const input = inputFrom(options);
  try {
    if (action === "reserve") {
      const coordinator = createVmMigrationCoordinator({db,
        requireSourceAudit: true,
        authorize: async (_, requestedAction) => requestedAction === "reserve"});
      console.log(JSON.stringify(await coordinator.reserve({...input,
        observationSha256: options.get("--observation-sha256")})));
    } else {
      const {GoogleAuth} = require("../functions/node_modules/google-auth-library");
      const {Storage} = require("../functions/node_modules/@google-cloud/storage");
      const {createVmLegacyComputeObserver} = require("../functions/vmLegacyComputeObservation.service.js");
      const {createVmMigrationStorageObserver} = require("../functions/vmMigrationStorageObservation.service.js");
      const {inspectCompute, inspectStorage} = createObservers({GoogleAuth, Storage, createVmLegacyComputeObserver,
        createVmMigrationStorageObserver});
      const coordinator = createVmMigrationCoordinator({db, inspectCompute, inspectStorage,
        defaultBucket: DEFAULT_BUCKET, authorize: async (_, requestedAction) => requestedAction === "quiesce"});
      console.log(JSON.stringify(await coordinator.confirmQuiesced(input)));
    }
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === "string" && /^(?:migration_reserve|vm_migration|compute|storage|legacy)_[a-z0-9_]+$/.test(code)
    ? code : "migration_reserve_failed";
  console.error(JSON.stringify({status: "blocked", reason, readyForCutover: false, sourceRetained: true}));
  process.exitCode = 1;
}
