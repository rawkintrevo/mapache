#!/usr/bin/env node
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const PROJECT = "pi-agents-cloud";
const DEFAULT_BUCKET = "pi-agents-cloud.firebasestorage.app";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FLAGS = new Set(["--project", "--workspace", "--owner"]);

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = argv.slice(index, index + 2);
    if (!FLAGS.has(flag) || !value || options.has(flag)) throw Error("migration_preflight_arguments_invalid");
    options.set(flag, value);
  }
  if (options.size !== FLAGS.size || options.get("--project") !== PROJECT ||
      !["--workspace", "--owner"].every(flag => IDENTIFIER.test(options.get(flag) || ""))) {
    throw Error("migration_preflight_arguments_invalid");
  }
  return options;
}

function createObservers({GoogleAuth, Storage, createVmLegacyComputeObserver, createVmMigrationStorageObserver}) {
  const storage = new Storage({projectId: PROJECT});
  const inspectCompute = createVmLegacyComputeObserver({
    auth: new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]}),
    projectId: PROJECT, projectNumber: "299764728235", defaultRegion: "us-central1", defaultBucket: DEFAULT_BUCKET,
  });
  const inspectStorage = createVmMigrationStorageObserver({defaultBucket: DEFAULT_BUCKET,
    listPage: async ({bucketName, ...query}) => {
      const [, , response] = await storage.bucket(bucketName).getFiles({...query, autoPaginate: false,
        fields: "nextPageToken,items(name,generation,metageneration,size,crc32c)"});
      return {objects: response.items || [], nextPageToken: response.nextPageToken};
    }});
  return {inspectCompute, inspectStorage};
}

try {
  const options = parseOptions(process.argv.slice(2));
  const admin = require("../functions/node_modules/firebase-admin");
  const {GoogleAuth} = require("../functions/node_modules/google-auth-library");
  const {Storage} = require("../functions/node_modules/@google-cloud/storage");
  const {createVmLegacyComputeObserver} = require("../functions/vmLegacyComputeObservation.service.js");
  const {createVmMigrationPreflight} = require("../functions/vmMigrationPreflight.service.js");
  const {createVmMigrationStorageObserver} = require("../functions/vmMigrationStorageObservation.service.js");
  const app = admin.initializeApp({projectId: PROJECT}, "vm-migration-preflight");
  try {
    const {inspectCompute, inspectStorage} = createObservers({GoogleAuth, Storage, createVmLegacyComputeObserver,
      createVmMigrationStorageObserver});
    const preflight = createVmMigrationPreflight({db: app.firestore(), inspectCompute, inspectStorage});
    console.log(JSON.stringify(await preflight({workspaceId: options.get("--workspace"), ownerUid: options.get("--owner"),
      checkCompute: true, checkStorage: true})));
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === "string" && /^(?:migration_preflight|vm_migration|legacy|compute|storage)_[a-z0-9_]+$/.test(code)
    ? code : "migration_preflight_failed";
  console.error(JSON.stringify({status: "blocked", reason, readyForCutover: false, sourceRetained: true}));
  process.exitCode = 1;
}
