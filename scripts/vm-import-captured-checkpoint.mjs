#!/usr/bin/env node
import {createRequire} from 'node:module';
import path from 'node:path';
import {importCapturedCheckpoint} from './lib/vm-captured-checkpoint-import.mjs';

const require = createRequire(import.meta.url);
const flags = new Set(['--project', '--workspace', '--owner', '--operation', '--kind', '--root', '--max-bytes']);

try {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const [flag, value] = process.argv.slice(index, index + 2);
    if (!flags.has(flag) || !value || options.has(flag)) throw Error('captured_import_invalid_arguments');
    options.set(flag, value);
  }
  if (options.size !== flags.size || options.get('--project') !== 'pi-agents-cloud' || !path.isAbsolute(options.get('--root'))) {
    throw Error('captured_import_invalid_arguments');
  }
  const admin = require('../functions/node_modules/firebase-admin');
  const {createVmMigrationCoordinator} = require('../functions/vmMigrationCoordinator.service.js');
  const app = admin.initializeApp({projectId: options.get('--project')}, 'captured-checkpoint-import');
  try {
    const coordinator = createVmMigrationCoordinator({db: app.firestore(), authorize: async (_, action) => action === 'read-prefix-capture'});
    const result = await importCapturedCheckpoint({
      input: {workspaceId: options.get('--workspace'), ownerUid: options.get('--owner'), operationId: options.get('--operation')},
      kind: options.get('--kind'), root: options.get('--root'), maxBytes: Number(options.get('--max-bytes')),
      readCapture: coordinator.getCapturedPrefix, storage: app.storage(),
    });
    console.log(JSON.stringify(result));
  } finally {
    await app.delete();
  }
} catch (error) {
  const message = error.publicMessage || error.message;
  const reason = /^(captured_import_|legacy_storage_capture_|vm_migration_|import_|payload_)[a-z_]+$/.test(message)
    ? message : 'captured_import_read_or_io_failed';
  console.error(JSON.stringify({status: 'blocked', reason, readyForCutover: false}));
  process.exitCode = 1;
}
