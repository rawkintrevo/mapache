#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {inspectMigrationSource} from './lib/vm-migration-inventory.mjs';
import {verifyCheckpointPayloads} from './lib/vm-checkpoint-payloads.mjs';
import {storageCandidates, inventoryStorageMetadata, inspectBrowserSeedMetadata} from './lib/vm-storage-metadata.mjs';
import {verifyGzipTar} from './lib/vm-archive-verifier.mjs';
import {inspectSharedTreeAuthority} from './lib/vm-shared-tree-authority.mjs';
const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
const {observeVmMigration} = require('../functions/vmMigrationPreflight.service.js');
const PROJECT = 'pi-agents-cloud';
const DEFAULT_BUCKET = 'pi-agents-cloud.firebasestorage.app';
const workspaceFields = ['ownerUid', 'source', 'imageKey', 'runtimeProvider.backend', 'status', 'lifecycle', 'deleted',
  'bucket', 'storagePrefix', 'workspaceStorageBucket', 'workspaceStoragePrefix', 'homePolicy',
  'sharedStorage', 'agentRuntimeGeneration', 'agentRuntimeCheckpoint', 'agentRuntimeWorkspaceFiles'];
const sessionFields = ['ownerUid', 'status', 'terminalKind', 'imageKey', 'runtimeProvider.backend',
  'bucket', 'workspaceStorageBucket', 'workspaceStoragePrefix', 'homeStorageBucket', 'homeStoragePrefix'];

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--project', '--output', '--workspace', '--verify-bytes', '--verify-flat-prefix-bytes', '--list-objects', '--default-bucket', '--tools-bucket', '--verify-archive-bytes', '--archive-expanded-bytes'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('invalid_arguments');
    options[args[i]] = args[i + 1];
  }
  if (options['--project'] !== 'pi-agents-cloud') throw Error('explicit_project_required');
  if (options['--workspace'] && !/^[A-Za-z0-9_-]{1,128}$/.test(options['--workspace'])) throw Error('invalid_workspace');
  const budget = {remaining: Number(options['--verify-bytes'] || 0)};
  if (options['--verify-bytes'] && (!options['--workspace'] || !Number.isSafeInteger(budget.remaining) || budget.remaining < 1)) throw Error('payload_verification_requires_workspace_and_byte_budget');
  const maxObjects = Number(options['--list-objects'] || 0);
  if (options['--list-objects'] && (!options['--workspace'] || !Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 100000)) throw Error('storage_inventory_requires_workspace_and_object_budget');
  const flatPrefixBudget = {remaining: Number(options['--verify-flat-prefix-bytes'] || 0)};
  if (options['--verify-flat-prefix-bytes'] && (!maxObjects || !options['--workspace'] || !Number.isSafeInteger(flatPrefixBudget.remaining) || flatPrefixBudget.remaining < 1)) {
    throw Error('flat_prefix_verification_requires_listing_and_byte_budget');
  }
  let archiveBudget = Number(options['--verify-archive-bytes'] || 0);
  const maxExpandedBytes = Number(options['--archive-expanded-bytes'] || 0);
  if ((options['--verify-archive-bytes'] || options['--archive-expanded-bytes']) && (!maxObjects || !Number.isSafeInteger(archiveBudget) || archiveBudget < 1 ||
      !Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1)) throw Error('archive_verification_requires_listing_and_explicit_limits');
  const defaultBucket = options['--default-bucket'] || process.env.SESSION_BUCKET || DEFAULT_BUCKET;
  const toolsBucket = options['--tools-bucket'] || process.env.USER_TOOLS_STORAGE_BUCKET || defaultBucket;
  admin.initializeApp({projectId: PROJECT});
  const db = admin.firestore(); const storage = admin.storage();
  async function* pages(collection, fields) {
    let cursor;
    do {
      let query = collection.orderBy(admin.firestore.FieldPath.documentId()).select(...fields).limit(100);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) yield doc;
      cursor = page.size === 100 ? page.docs.at(-1).id : null;
    } while (cursor);
  }
  async function readManifest(ref) {
    try {
    const object = storage.bucket(ref.bucketName).file(ref.objectPath);
    const [metadata] = await object.getMetadata();
    if (Number(metadata.size) !== ref.byteLength) throw Error('manifest_size_mismatch');
    const [content] = await storage.bucket(ref.bucketName).file(ref.objectPath, {generation: metadata.generation}).download();
    return {content, objectGeneration: metadata.generation};
    } catch (error) {
      if (Number(error.code) === 404) throw Error('manifest_object_not_found');
      if ([401, 403].includes(Number(error.code))) throw Error('manifest_access_denied');
      if (error.message === 'manifest_size_mismatch') throw error;
      throw Error('manifest_unavailable_or_invalid');
    }
  }
  const records = [];
  async function openObject(ref) {
    try {
      const [metadata] = await storage.bucket(ref.bucketName).file(ref.objectPath).getMetadata();
      if (Number(metadata.size) !== ref.byteLength) throw Error('payload_size_mismatch');
      if (ref.objectGeneration && String(metadata.generation) !== String(ref.objectGeneration)) throw Error('payload_generation_changed');
      return {generation: metadata.generation, stream: storage.bucket(ref.bucketName).file(ref.objectPath, {generation: metadata.generation}).createReadStream()};
    } catch (error) {
      if (Number(error.code) === 404) throw Error('payload_object_not_found');
      if ([401, 403].includes(Number(error.code))) throw Error('payload_access_denied');
      if (['payload_size_mismatch', 'payload_generation_changed'].includes(error.message)) throw error;
      throw Error('payload_unavailable');
    }
  }
  async function verifyFlatPrefixObject({candidate, object}) {
    const byteLength = Number(object.size);
    if (byteLength > flatPrefixBudget.remaining) return {status: 'blocked', reason: 'flat_prefix_payload_budget_exceeded'};
    try {
      const pinned = await openObject({bucketName: candidate.bucketName, objectPath: object.name,
        byteLength, objectGeneration: object.generation});
      const hash = createHash('sha256'); let readBytes = 0;
      for await (const chunk of pinned.stream) {
        readBytes += chunk.length;
        if (readBytes > byteLength || readBytes > flatPrefixBudget.remaining) throw Error('flat_prefix_payload_budget_exceeded');
        hash.update(chunk);
      }
      if (readBytes !== byteLength) throw Error('flat_prefix_payload_unavailable');
      flatPrefixBudget.remaining -= readBytes;
      return {status: 'verified', byteLength: readBytes, sha256: hash.digest('hex')};
    } catch (error) {
      if (['flat_prefix_payload_budget_exceeded', 'payload_generation_changed'].includes(error.message)) return {status: 'blocked', reason: error.message};
      return {status: 'blocked', reason: 'flat_prefix_payload_unavailable'};
    }
  }
  const workspaces = options['--workspace'] ? (await db.collection('workspaces')
      .where(admin.firestore.FieldPath.documentId(), '==', options['--workspace']).select(...workspaceFields).get()).docs : pages(db.collection('workspaces'), workspaceFields);
  if (options['--workspace'] && !workspaces.length) throw Error('workspace_not_found');
  for await (const doc of workspaces) {
    if (!doc.exists) throw Error('workspace_not_found');
    const sessions = [];
    for await (const session of pages(doc.ref.collection('sessions'), sessionFields)) sessions.push({id: session.id, ...session.data()});
    const record = await inspectMigrationSource({workspaceId: doc.id, workspace: doc.data(), sessions, readManifest,
      inspectSharedTree: maxObjects ? args => inspectSharedTreeAuthority({...args,
        readBucketMetadata: async bucket => (await storage.bucket(bucket).getMetadata())[0],
        readJsonObject: async ({bucketName, objectPath, maxBytes}) => {
          const [metadata] = await storage.bucket(bucketName).file(objectPath).getMetadata();
          if (!Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) > maxBytes) throw Error('shared_json_invalid');
          const chunks = []; let size = 0;
          for await (const chunk of storage.bucket(bucketName).file(objectPath, {generation: metadata.generation}).createReadStream()) {
            size += chunk.length; if (size > maxBytes) throw Error('shared_json_invalid'); chunks.push(chunk);
          }
          return {content: Buffer.concat(chunks), generation: metadata.generation};
        },
      }) : undefined,
      verifyPayloads: options['--verify-bytes'] ? (manifest, manifestRef) => verifyCheckpointPayloads({manifest, manifestRef, openObject, budget}) : undefined});
    if (typeof doc.get('ownerUid') === 'string' && doc.get('ownerUid')) {
      try {
        const observed = await db.runTransaction(transaction => observeVmMigration(transaction, {
          db, workspaceId: doc.id, ownerUid: doc.get('ownerUid'),
        }), {readOnly: true});
        record.observationSha256 = observed.observationSha256;
        record.sourceObservationSha256 = observed.sourceObservationSha256;
        record.sourceGeneration = observed.sourceGeneration;
      } catch {
        record.blockers = [...new Set([...(record.blockers || []), 'migration_observation_unavailable'])].sort();
      }
    }
    const blocked = await db.collection('vmMigrationBlockedReports_v2').doc(doc.id).get();
    if (blocked.exists) {
      const data = blocked.data() || {};
      record.blockedReport = {
        state: data.state === 'blocked' ? 'blocked' : 'unknown',
        decision: data.decision === 'source-retained' ? 'source-retained' : 'unknown',
        sourceGeneration: Number.isSafeInteger(data.sourceGeneration) ? data.sourceGeneration : null,
        sourceObservationSha256: /^[a-f0-9]{64}$/.test(data.sourceObservationSha256 || '') ? data.sourceObservationSha256 : null,
        blockers: Array.isArray(data.blockers) ? data.blockers.filter(value => /^[a-z0-9_]+$/.test(value)).sort() : [],
        sourceRetained: data.sourceRetained === true,
        recordedAtMs: Number.isSafeInteger(data.recordedAtMs) ? data.recordedAtMs : null,
      };
    }
    if (maxObjects) record.storageMetadata = await inventoryStorageMetadata({
      ...storageCandidates({workspace: doc.data(), sessions, defaultBucket, toolsBucket}), maxObjects,
      listPage: async ({bucketName, prefix, pageToken, limit}) => {
        const [files, next] = await storage.bucket(bucketName).getFiles({prefix, pageToken, maxResults: limit, autoPaginate: false});
        return {objects: files.map(file => file.metadata), nextPageToken: next?.pageToken || null};
      },
      verifyObject: options['--verify-flat-prefix-bytes'] ? verifyFlatPrefixObject : undefined,
      inspectBrowserSeed: ({bucketName, prefix}) => inspectBrowserSeedMetadata({workspaceId: doc.id,
        workspacePrefix: doc.data().storagePrefix || doc.data().workspaceStoragePrefix, bucketName,
        readPointer: async () => {
          const objectPath = `${prefix}/current.json`;
          const [metadata] = await storage.bucket(bucketName).file(objectPath).getMetadata();
          if (!Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) < 0 || Number(metadata.size) > 65536) throw Error('browser_seed_pointer_too_large');
          const chunks = []; let length = 0;
          for await (const chunk of storage.bucket(bucketName).file(objectPath, {generation: metadata.generation}).createReadStream()) {
            length += chunk.length;
            if (length > 65536) throw Error('browser_seed_pointer_too_large');
            chunks.push(chunk);
          }
          return {content: Buffer.concat(chunks), generation: metadata.generation};
        },
        readObjectMetadata: async ref => (await storage.bucket(ref.bucketName).file(ref.objectPath, {generation: ref.generation}).getMetadata())[0],
        verifyArchive: options['--verify-archive-bytes'] ? async descriptor => {
          if (descriptor.byteLength > archiveBudget) return {status: 'blocked', reason: 'archive_download_budget_exceeded'};
          archiveBudget -= descriptor.byteLength;
          return verifyGzipTar({stream: storage.bucket(descriptor.bucketName).file(descriptor.objectPath, {generation: descriptor.objectGeneration}).createReadStream(),
            byteLength: descriptor.byteLength, sha256: descriptor.sha256, maxCompressedBytes: descriptor.byteLength, maxExpandedBytes, maxEntries: 100000});
        } : undefined,
      }),
    });
    records.push(record);
  }
  const vmRecords = [];
  for await (const doc of pages(db.collection('vmRuntimes_v2'),
      ['ownerUid', 'backend', 'generation', 'state', 'apiEnabled', 'lifecycleEnabled', 'migrationAuthority', 'migrationOperationId'])) {
    if (!options['--workspace'] || options['--workspace'] === doc.id) vmRecords.push({workspaceId: doc.id, ...doc.data()});
  }
  const report = {schemaVersion: 1, projectId: PROJECT, capturedAt: new Date().toISOString(), readOnly: true,
    scope: 'Firestore registry plus published checkpoint manifest validation; not a full storage inventory or cutover approval',
    workspaces: records, existingVmRecords: vmRecords};
  const destination = options['--output'] || `artifacts/qa/vm-migration-inventory/${Date.now()}.json`;
  await mkdir(path.dirname(destination), {recursive: true});
  await writeFile(destination, JSON.stringify(report, null, 2), {mode: 0o600, flag: 'wx'});
  const classifications = {};
  for (const record of records) classifications[record.classification] = (classifications[record.classification] || 0) + 1;
  console.log(JSON.stringify({ok: true, readOnly: true, workspaces: records.length, vmRecords: vmRecords.length, classifications,
    readyForCutover: records.filter(record => record.readyForCutover).length,
    explicitlyBlocked: records.filter(record => record.blockedReport?.state === 'blocked' &&
      record.blockedReport?.decision === 'source-retained' && record.blockedReport?.sourceRetained === true).length,
    report: destination}));
}
main().catch(() => { console.error('VM inventory failed; no remote changes were made. Check arguments, access and local output path.'); process.exitCode = 1; });
