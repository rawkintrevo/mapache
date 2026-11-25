#!/usr/bin/env node
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const flags = new Set(["--project", "--workspace", "--owner", "--operation"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

try {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const [flag, value] = process.argv.slice(index, index + 2);
    if (!flags.has(flag) || !value || options.has(flag)) throw Error("destination_cleanup_arguments_invalid");
    options.set(flag, value);
  }
  if (options.size !== flags.size || options.get("--project") !== "pi-agents-cloud" ||
      !["--workspace", "--owner", "--operation"].every(flag => IDENTIFIER.test(options.get(flag) || ""))) {
    throw Error("destination_cleanup_arguments_invalid");
  }

  const admin = require("../functions/node_modules/firebase-admin");
  const {createComputeEngineService} = require("../functions/computeEngine.service.js");
  const {createVmMigrationCoordinator} = require("../functions/vmMigrationCoordinator.service.js");
  const app = admin.initializeApp({projectId: "pi-agents-cloud"}, "vm-migration-destination-cleanup");
  const compute = createComputeEngineService({projectId: "pi-agents-cloud"});
  try {
    const coordinator = createVmMigrationCoordinator({db: app.firestore(),
      inspectDestinationDisk: compute.inspectMigrationDisk,
      deleteImportedDisk: compute.deleteMigrationImportedDisk,
      authorize: async (_, action) => action === "cleanup-imported-disk",
    });
    const result = await coordinator.cleanupImportedDisk({workspaceId: options.get("--workspace"),
      ownerUid: options.get("--owner"), operationId: options.get("--operation")});
    console.log(JSON.stringify(result));
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === "string" && /^(?:destination_cleanup_|vm_migration_|runtime_migration_|runtime_data_|compute_)[a-z0-9_]+$/.test(code)
    ? code : "destination_cleanup_failed";
  console.error(JSON.stringify({status: "blocked", reason, readyForCutover: false, sourceRetained: true}));
  process.exitCode = 1;
}
