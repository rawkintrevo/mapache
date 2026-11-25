#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {buildSourceAudit} from './lib/vm-migration-source-audit.mjs';

const require = createRequire(import.meta.url);
const PROJECT = 'pi-agents-cloud';
const DEFAULT_BUCKET = 'pi-agents-cloud.firebasestorage.app';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FLAGS = new Set(['--project', '--workspace', '--owner', '--observation-sha256', '--report', '--evidence', '--confirm']);

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = argv.slice(index, index + 2);
    if (!FLAGS.has(flag) || !value || options.has(flag)) throw Error('source_audit_arguments_invalid');
    options.set(flag, value);
  }
  if (options.size !== FLAGS.size || options.get('--project') !== PROJECT ||
      !['--workspace', '--owner'].every(flag => IDENTIFIER.test(options.get(flag) || '')) ||
      !DIGEST.test(options.get('--observation-sha256') || '') ||
      options.get('--confirm') !== 'migration-record-source-audit') throw Error('source_audit_arguments_invalid');
  return options;
}

function readJson(value, reason) {
  try { return JSON.parse(value); } catch { throw Error(reason); }
}

function createObservers({GoogleAuth, Storage, createVmLegacyComputeObserver, createVmMigrationStorageObserver}) {
  const storage = new Storage({projectId: PROJECT});
  const inspectCompute = createVmLegacyComputeObserver({auth: new GoogleAuth({scopes: ['https://www.googleapis.com/auth/cloud-platform']}),
    projectId: PROJECT, projectNumber: '299764728235', defaultRegion: 'us-central1', defaultBucket: DEFAULT_BUCKET});
  const inspectStorage = createVmMigrationStorageObserver({defaultBucket: DEFAULT_BUCKET,
    listPage: async ({bucketName, ...query}) => {
      const [, , response] = await storage.bucket(bucketName).getFiles({...query, autoPaginate: false,
        fields: 'nextPageToken,items(name,generation,metageneration,size,crc32c)'});
      return {objects: response.items || [], nextPageToken: response.nextPageToken};
    }});
  return {inspectCompute, inspectStorage};
}

try {
  const options = parseOptions(process.argv.slice(2));
  const report = readJson(await readFile(options.get('--report'), 'utf8'), 'source_audit_report_invalid');
  const evidence = readJson(await readFile(options.get('--evidence'), 'utf8'), 'source_audit_evidence_invalid');
  if (report.readOnly !== true || !Array.isArray(report.workspaces)) throw Error('source_audit_report_invalid');
  const workspaceId = options.get('--workspace');
  const inventory = report.workspaces.find(record => record.workspaceId === workspaceId);
  if (!inventory || !inventory.storageMetadata) throw Error('source_audit_inventory_missing');

  const admin = require('../functions/node_modules/firebase-admin');
  const {GoogleAuth} = require('../functions/node_modules/google-auth-library');
  const {Storage} = require('../functions/node_modules/@google-cloud/storage');
  const {createVmLegacyComputeObserver} = require('../functions/vmLegacyComputeObservation.service.js');
  const {createVmMigrationPreflight, observeVmMigration} = require('../functions/vmMigrationPreflight.service.js');
  const {resolveMigrationPrefix} = require('../functions/vmMigrationStorageScope.helpers.js');
  const app = admin.initializeApp({projectId: PROJECT}, 'vm-migration-record-source-audit');
  try {
    const db = app.firestore();
    const {createVmMigrationStorageObserver} = require('../functions/vmMigrationStorageObservation.service.js');
    const {inspectCompute, inspectStorage} = createObservers({GoogleAuth, Storage, createVmLegacyComputeObserver, createVmMigrationStorageObserver});
    const preflight = createVmMigrationPreflight({db, inspectCompute, inspectStorage});
    const observed = await preflight({workspaceId, ownerUid: options.get('--owner'), checkCompute: true, checkStorage: true});
    if (observed.observationSha256 !== options.get('--observation-sha256')) throw Error('source_audit_observation_stale');
    const source = await db.collection('workspaces').doc(workspaceId).get();
    if (!source.exists || source.get('ownerUid') !== options.get('--owner')) throw Error('source_audit_source_not_found');
    const scope = resolveMigrationPrefix(source.data(), options.get('--owner'), DEFAULT_BUCKET);
    const audit = buildSourceAudit({preflight: observed, inventory, storageMetadata: inventory.storageMetadata, scope,
      coverage: evidence.coverage, costDowntime: evidence.costDowntime});
    const auditRef = db.collection('vmMigrationSourceAudits_v2').doc(workspaceId);
    const result = await db.runTransaction(async transaction => {
      const existing = await transaction.get(auditRef);
      const current = await observeVmMigration(transaction, {db, workspaceId, ownerUid: options.get('--owner')});
      if (current.observationSha256 !== audit.observationSha256 || current.sourceObservationSha256 !== audit.sourceObservationSha256 ||
          current.sourceGeneration !== audit.sourceGeneration || current.blockers.includes('migration_fence_already_exists')) {
        throw Error('source_audit_source_changed');
      }
      if (existing.exists && (existing.get('ownerUid') !== audit.ownerUid || existing.get('sourceObservationSha256') !== audit.sourceObservationSha256)) {
        transaction.update(auditRef, audit);
      } else if (existing.exists) {
        transaction.update(auditRef, audit);
      } else {
        transaction.create(auditRef, audit);
      }
      return {created: !existing.exists, audit};
    });
    console.log(JSON.stringify(result));
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === 'string' && /^(?:source_audit|vm_migration|legacy|compute|storage)_[a-z0-9_]+$/.test(code)
    ? code : 'source_audit_record_failed';
  console.error(JSON.stringify({status: 'blocked', reason, readyForCutover: false, sourceRetained: true}));
  process.exitCode = 1;
}
