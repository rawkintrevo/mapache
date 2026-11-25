#!/usr/bin/env node
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const PROJECT = "pi-agents-cloud";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FLAGS = new Set(["--project", "--workspace", "--owner", "--operation", "--confirm"]);

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = argv.slice(index, index + 2);
    if (!FLAGS.has(flag) || !value || options.has(flag)) throw Error("migration_abort_arguments_invalid");
    options.set(flag, value);
  }
  if (options.size !== FLAGS.size || options.get("--project") !== PROJECT ||
      options.get("--confirm") !== "migration-abort" ||
      !["--workspace", "--owner", "--operation"].every(flag => IDENTIFIER.test(options.get(flag) || ""))) {
    throw Error("migration_abort_arguments_invalid");
  }
  return options;
}

try {
  const options = parseOptions(process.argv.slice(2));
  const admin = require("../functions/node_modules/firebase-admin");
  const {createVmMigrationCoordinator} = require("../functions/vmMigrationCoordinator.service.js");
  const app = admin.initializeApp({projectId: PROJECT}, "vm-migration-abort");
  try {
    const coordinator = createVmMigrationCoordinator({db: app.firestore(),
      authorize: async (_, action) => action === "abort"});
    console.log(JSON.stringify(await coordinator.abort({workspaceId: options.get("--workspace"),
      ownerUid: options.get("--owner"), operationId: options.get("--operation")})));
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === "string" && /^(?:migration_abort|vm_migration|runtime_migration|runtime_data)_[a-z0-9_]+$/.test(code)
    ? code : "migration_abort_failed";
  console.error(JSON.stringify({status: "blocked", reason, readyForCutover: false, sourceRetained: true}));
  process.exitCode = 1;
}
