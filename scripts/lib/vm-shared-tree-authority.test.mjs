import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {inspectSharedTreeAuthority} from './vm-shared-tree-authority.mjs';
import {inspectMigrationSource} from './vm-migration-inventory.mjs';
const require = createRequire(import.meta.url);
const {expectedBucketLabels} = require('../../functions/workspaceBucketAccess.service.js');
function fixture() {
  const workspaceId = 'workspace'; const ownerUid = 'owner'; const generation = 'capture';
  const sharedStorage = {projectId: 'pi-agents-cloud', projectNumber: '123', storageGeneration: generation,
    bucketName: `mpw-123-${createHash('sha256').update(workspaceId).digest('hex').slice(0, 24)}`,
    treePrefix: 'trees/capture', readyMarker: '.mapache-internal/workspace-ready.json'};
  const marker = {kind: 'mapache-shared-workspace-ready', state: 'ready', storageGeneration: generation, operationId: generation};
  const control = {version: 1, kind: 'mapache-shared-workspace-import', state: 'ready', source: {workspaceId},
    operationId: generation, storageGeneration: generation, treePrefix: sharedStorage.treePrefix, objects: [], gitSeed: null};
  const args = {workspaceId, workspace: {ownerUid, sharedStorage},
    readBucketMetadata: async () => ({name: sharedStorage.bucketName, projectNumber: '123', labels: expectedBucketLabels({workspaceId, ownerUid}), hierarchicalNamespace: {enabled: true}}),
    readJsonObject: async ({maxBytes}) => ({generation: '456', content: Buffer.from(JSON.stringify(maxBytes === 65536 ? marker : control))})};
  return {args, marker, control};
}
test('valid ownership, marker and original control produce bounded provenance evidence only', async () => {
  const {args} = fixture(); const result = await inspectSharedTreeAuthority(args);
  assert.equal(result.status, 'marker-and-control-verified');
  assert.equal(result.hierarchicalFoldersRequireInventory, true);
  assert.match(result.markerSha256, /^[a-f0-9]{64}$/);
  const record = await inspectMigrationSource({...args, sessions: [], inspectSharedTree: () => inspectSharedTreeAuthority(args)});
  assert.equal(record.readyForCutover, false);
  assert.ok(record.blockers.includes('shared_tree_marker_and_objects_not_verified'));
});
test('missing bucket, denied access and absent control remain distinct without raw errors', async () => {
  const {args} = fixture();
  for (const [code, reason] of [[404, 'shared_bucket_not_found'], [403, 'shared_source_access_denied']]) {
    assert.deepEqual(await inspectSharedTreeAuthority({...args, readBucketMetadata: async () => { throw Object.assign(Error('private-url'), {code}); }}), {status: 'blocked', reason});
  }
  const original = args.readJsonObject;
  args.readJsonObject = ref => { if (ref.maxBytes > 65536) throw Object.assign(Error('private-url'), {code: 404}); return original(ref); };
  assert.equal((await inspectSharedTreeAuthority(args)).status, 'marker-verified-control-missing');
});
test('foreign descriptors, labels, marker generations and control workspace fail closed', async () => {
  for (const mutate of [f => { f.args.workspace.sharedStorage.treePrefix = 'trees/foreign'; },
    f => { f.args.workspace.ownerUid = 'foreign'; }, f => { f.marker.storageGeneration = 'old'; },
    f => { f.control.source.workspaceId = 'foreign'; }]) {
    const f = fixture(); mutate(f); assert.equal((await inspectSharedTreeAuthority(f.args)).status, 'blocked');
  }
});
test('oversized or malformed JSON and absent object generations are rejected', async () => {
  for (const object of [{content: Buffer.alloc(65537), generation: '1'}, {content: Buffer.from('{'), generation: '1'}, {content: Buffer.from('{}'), generation: ''}]) {
    const {args} = fixture();
    assert.equal((await inspectSharedTreeAuthority({...args, readJsonObject: async () => object})).reason, 'shared_json_invalid');
  }
});
