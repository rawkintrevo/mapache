#!/usr/bin/env node
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {inspectMigrationSource} from './lib/vm-migration-inventory.mjs';
const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
const workspaceFields = ['ownerUid', 'source', 'imageKey', 'runtimeProvider.backend', 'status', 'lifecycle', 'deleted',
  'sharedStorage', 'agentRuntimeGeneration', 'agentRuntimeCheckpoint', 'agentRuntimeWorkspaceFiles'];
const sessionFields = ['ownerUid', 'status', 'terminalKind', 'imageKey', 'runtimeProvider.backend'];

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--project', '--output', '--workspace'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('invalid_arguments');
    options[args[i]] = args[i + 1];
  }
  if (options['--project'] !== 'pi-agents-cloud') throw Error('explicit_project_required');
  if (options['--workspace'] && !/^[A-Za-z0-9_-]{1,128}$/.test(options['--workspace'])) throw Error('invalid_workspace');
  admin.initializeApp({projectId: 'pi-agents-cloud'});
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
  const workspaces = options['--workspace'] ? (await db.collection('workspaces')
      .where(admin.firestore.FieldPath.documentId(), '==', options['--workspace']).select(...workspaceFields).get()).docs : pages(db.collection('workspaces'), workspaceFields);
  if (options['--workspace'] && !workspaces.length) throw Error('workspace_not_found');
  for await (const doc of workspaces) {
    if (!doc.exists) throw Error('workspace_not_found');
    const sessions = [];
    for await (const session of pages(doc.ref.collection('sessions'), sessionFields)) sessions.push({id: session.id, ...session.data()});
    records.push(await inspectMigrationSource({workspaceId: doc.id, workspace: doc.data(), sessions, readManifest}));
  }
  const vmRecords = [];
  for await (const doc of pages(db.collection('vmRuntimes_v2'), ['ownerUid', 'generation', 'state'])) {
    if (!options['--workspace'] || options['--workspace'] === doc.id) vmRecords.push({workspaceId: doc.id, ...doc.data()});
  }
  const report = {schemaVersion: 1, projectId: 'pi-agents-cloud', capturedAt: new Date().toISOString(), readOnly: true,
    scope: 'Firestore registry plus published checkpoint manifest validation; not a full storage inventory or cutover approval',
    workspaces: records, existingVmRecords: vmRecords};
  const destination = options['--output'] || `artifacts/qa/vm-migration-inventory/${Date.now()}.json`;
  await mkdir(path.dirname(destination), {recursive: true});
  await writeFile(destination, JSON.stringify(report, null, 2), {mode: 0o600, flag: 'wx'});
  const classifications = {};
  for (const record of records) classifications[record.classification] = (classifications[record.classification] || 0) + 1;
  console.log(JSON.stringify({ok: true, readOnly: true, workspaces: records.length, vmRecords: vmRecords.length, classifications,
    readyForCutover: records.filter(record => record.readyForCutover).length, report: destination}));
}
main().catch(() => { console.error('VM inventory failed; no remote changes were made. Check arguments, access and local output path.'); process.exitCode = 1; });
