#!/usr/bin/env node
"use strict";

const {createConfig} = require("../lib/config");
const {createSharedWorkspaceImportService} = require("../lib/sharedWorkspaceImport.service");
const {storage} = require("../lib/services");

function parseArgs(args = []) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (!key || index + 1 >= args.length || args[index + 1].startsWith("--")) {
      throw new Error(`missing value for --${argument.slice(2)}`);
    }
    values[key] = args[++index];
  }
  return values;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const sourceRoot = args.sourceRoot || process.env.MAPACHE_IMPORT_SOURCE_ROOT;
  const operationId = args.operationId || process.env.MAPACHE_IMPORT_OPERATION_ID;
  const bucketName = args.bucket || process.env.STORAGE_BUCKET;
  if (!sourceRoot) throw new Error("--source-root or MAPACHE_IMPORT_SOURCE_ROOT is required");
  if (!bucketName) throw new Error("--bucket or STORAGE_BUCKET is required");
  if (!operationId) throw new Error("--operation-id or MAPACHE_IMPORT_OPERATION_ID is required");
  const config = createConfig();
  const service = createSharedWorkspaceImportService({config, storage});
  return service.importWorktree({bucketName, operationId, sourceRoot});
}

if (require.main === module) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || "shared_workspace_migration_failed"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {parseArgs, run};
