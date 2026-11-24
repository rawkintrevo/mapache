#!/usr/bin/env node
import {createRequire} from 'node:module';
import {createIapMaintenanceEvidenceReader} from './lib/vm-maintenance-evidence.mjs';

const require = createRequire(import.meta.url);
const flags = new Set(['--project', '--workspace', '--owner', '--operation', '--maintenance-instance', '--maintenance-id']);

try {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const [flag, value] = process.argv.slice(index, index + 2);
    if (!flags.has(flag) || !value || options.has(flag)) throw Error('maintenance_config_invalid');
    options.set(flag, value);
  }
  const projectId = options.get('--project');
  const maintenance = {instanceName: options.get('--maintenance-instance'), instanceId: options.get('--maintenance-id')};
  if (options.size !== flags.size || projectId !== 'pi-agents-cloud' ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(maintenance.instanceName) || !/^[1-9][0-9]{0,19}$/.test(maintenance.instanceId)) {
    throw Error('maintenance_config_invalid');
  }
  const admin = require('../functions/node_modules/firebase-admin');
  const {createComputeEngineService} = require('../functions/computeEngine.service.js');
  const {createVmMigrationCoordinator} = require('../functions/vmMigrationCoordinator.service.js');
  const app = admin.initializeApp({projectId}, 'migration-disk-verification');
  const compute = createComputeEngineService({projectId});
  const readDiskImportEvidence = createIapMaintenanceEvidenceReader({projectId, compute, maintenance});
  try {
    const coordinator = createVmMigrationCoordinator({db: app.firestore(), inspectDestinationDisk: compute.inspectMigrationDisk,
      readDiskImportEvidence, authorize: async (_, action) => action === 'verify-disk-import'});
    const result = await coordinator.verifyDiskImport({workspaceId: options.get('--workspace'),
      ownerUid: options.get('--owner'), operationId: options.get('--operation')});
    console.log(JSON.stringify(result));
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === 'string' && /^(maintenance_|vm_migration_|legacy_storage_capture_|runtime_|compute_)[a-z_]+$/.test(code)
    ? code : 'maintenance_verification_failed';
  console.error(JSON.stringify({status: 'blocked', reason, readyForCutover: false}));
  process.exitCode = 1;
}
