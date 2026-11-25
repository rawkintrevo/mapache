#!/usr/bin/env node
import {createRequire} from "node:module";
import {buildBlockedSourceReport} from "./lib/vm-migration-blocked-report.mjs";

const require = createRequire(import.meta.url);
const PROJECT = "pi-agents-cloud";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FLAGS = new Set(["--project", "--workspace", "--owner", "--observation-sha256", "--confirm"]);

function parseOptions() {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const [flag, value] = process.argv.slice(index, index + 2);
    if (!FLAGS.has(flag) || !value || options.has(flag)) throw Error("blocked_source_arguments_invalid");
    options.set(flag, value);
  }
  if (options.size !== FLAGS.size || options.get("--project") !== PROJECT ||
      options.get("--confirm") !== "migration-record-blocked" ||
      !["--workspace", "--owner"].every(flag => IDENTIFIER.test(options.get(flag) || "")) ||
      !DIGEST.test(options.get("--observation-sha256") || "")) {
    throw Error("blocked_source_arguments_invalid");
  }
  return options;
}

try {
  const options = parseOptions();
  const admin = require("../functions/node_modules/firebase-admin");
  const {GoogleAuth} = require("../functions/node_modules/google-auth-library");
  const {Storage} = require("../functions/node_modules/@google-cloud/storage");
  const {createVmLegacyComputeObserver} = require("../functions/vmLegacyComputeObservation.service.js");
  const {createVmMigrationPreflight, observeVmMigration} = require("../functions/vmMigrationPreflight.service.js");
  const {createVmMigrationStorageObserver} = require("../functions/vmMigrationStorageObservation.service.js");
  const app = admin.initializeApp({projectId: PROJECT}, "vm-migration-record-blocked");
  const db = app.firestore();
  const auth = new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]});
  const storage = new Storage({projectId: PROJECT});
  const inspectCompute = createVmLegacyComputeObserver({auth, projectId: PROJECT, projectNumber: "299764728235",
    defaultRegion: "us-central1", defaultBucket: "pi-agents-cloud.firebasestorage.app"});
  const inspectStorage = createVmMigrationStorageObserver({defaultBucket: "pi-agents-cloud.firebasestorage.app",
    listPage: async ({bucketName, ...query}) => {
      const [, , response] = await storage.bucket(bucketName).getFiles({...query, autoPaginate: false,
        fields: "nextPageToken,items(name,generation,metageneration,size,crc32c)"});
      return {objects: response.items || [], nextPageToken: response.nextPageToken};
    }});
  const workspaceId = options.get("--workspace");
  const ownerUid = options.get("--owner");
  const preflight = createVmMigrationPreflight({db, inspectCompute, inspectStorage});
  try {
    const observed = await preflight({workspaceId, ownerUid, checkCompute: true, checkStorage: true});
    const report = buildBlockedSourceReport({preflight: observed,
      expectedObservationSha256: options.get("--observation-sha256"), workspaceId, ownerUid});
    const reportRef = db.collection("vmMigrationBlockedReports_v2").doc(workspaceId);
    const sourceRef = db.collection("workspaces").doc(workspaceId);
    const result = await db.runTransaction(async transaction => {
      const [existing, source] = await Promise.all([transaction.get(reportRef), transaction.get(sourceRef)]);
      if (!source.exists || source.get("ownerUid") !== ownerUid) throw Error("blocked_source_not_found");
      const current = await observeVmMigration(transaction, {db, workspaceId, ownerUid});
      if (current.sourceObservationSha256 !== report.sourceObservationSha256 ||
          current.sourceGeneration !== report.sourceGeneration) throw Error("blocked_source_observation_changed");
      if (existing.exists) {
        const prior = existing.data();
        if (prior.ownerUid !== ownerUid || prior.state !== "blocked" || prior.decision !== "source-retained" ||
            prior.sourceRetained !== true) throw Error("blocked_source_report_conflict");
        transaction.update(reportRef, report);
        return {created: false, updated: true, report};
      }
      transaction.create(reportRef, report);
      return {created: true, updated: false, report};
    });
    console.log(JSON.stringify({...result.report, created: result.created, updated: result.updated === true}));
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === "string" && /^(?:blocked_source_|vm_migration_|compute_)[a-z0-9_]+$/.test(code)
    ? code : "blocked_source_report_failed";
  console.error(JSON.stringify({status: "blocked", reason, readyForCutover: false, sourceRetained: true}));
  process.exitCode = 1;
}

