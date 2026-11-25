#!/usr/bin/env node
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const PROJECT = "pi-agents-cloud";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ZONE = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/;
const FLAGS = new Set(["--project", "--workspace", "--owner", "--operation", "--zone", "--generation",
  "--destination-operation", "--confirm"]);

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = argv.slice(index, index + 2);
    if (!FLAGS.has(flag) || !value || options.has(flag)) throw Error("migration_register_disk_arguments_invalid");
    options.set(flag, value);
  }
  const required = ["--project", "--workspace", "--owner", "--operation", "--zone", "--generation",
    "--destination-operation", "--confirm"];
  if (!required.every(flag => options.has(flag)) || options.size !== FLAGS.size || options.get("--project") !== PROJECT ||
      options.get("--confirm") !== "migration-register-disk" ||
      !["--workspace", "--owner", "--operation", "--destination-operation"].every(flag => IDENTIFIER.test(options.get(flag) || "")) ||
      !ZONE.test(options.get("--zone") || "")) {
    throw Error("migration_register_disk_arguments_invalid");
  }
  const generation = Number(options.get("--generation"));
  if (!Number.isSafeInteger(generation) || generation < 1) throw Error("migration_register_disk_generation_invalid");
  return {options, generation};
}

try {
  const {options, generation} = parseOptions(process.argv.slice(2));
  const admin = require("../functions/node_modules/firebase-admin");
  const {createComputeEngineService} = require("../functions/computeEngine.service.js");
  const {createVmMigrationCoordinator} = require("../functions/vmMigrationCoordinator.service.js");
  const app = admin.initializeApp({projectId: PROJECT}, "vm-migration-register-disk");
  const compute = createComputeEngineService({projectId: PROJECT});
  try {
    const coordinator = createVmMigrationCoordinator({db: app.firestore(),
      inspectDestinationDisk: compute.inspectMigrationDisk,
      authorize: async (_, action) => action === "register-import-disk"});
    console.log(JSON.stringify(await coordinator.registerImportDisk({
      workspaceId: options.get("--workspace"), ownerUid: options.get("--owner"), operationId: options.get("--operation"),
      destination: {zone: options.get("--zone"), generation, operationId: options.get("--destination-operation")},
    })));
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === "string" && /^(?:migration_register_disk|vm_migration|compute|runtime)_[a-z0-9_]+$/.test(code)
    ? code : "migration_register_disk_failed";
  console.error(JSON.stringify({status: "blocked", reason, readyForCutover: false, sourceRetained: true}));
  process.exitCode = 1;
}
