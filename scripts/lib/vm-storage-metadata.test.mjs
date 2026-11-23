import test from 'node:test';
import assert from 'node:assert/strict';
import {storageCandidates, inventoryStorageMetadata, inspectBrowserSeedMetadata} from './vm-storage-metadata.mjs';
const workspace = {ownerUid: 'owner', bucket: 'workspace-bucket', storagePrefix: 'workspaces/owner/workspace'};
const object = (name, size = 10) => ({name, size: String(size), generation: '123', crc32c: 'abc='});
const candidate = {roles: ['workspace'], bucketName: 'workspace-bucket', prefix: workspace.storagePrefix};

test('candidate discovery covers current/legacy internal paths, custom HOME, shared trees, session references and explicit owner tools', () => {
  const plan = storageCandidates({workspace: {...workspace, homePolicy: {bucket: 'home-bucket', storagePrefix: 'custom/.mapahce-internal/home'},
    sharedStorage: {bucketName: 'shared-bucket', storageGeneration: 'generation'}},
  sessions: [{workspaceStorageBucket: workspace.bucket, workspaceStoragePrefix: workspace.storagePrefix,
    homeStorageBucket: 'old-home-bucket', homeStoragePrefix: 'old/home'}], toolsBucket: 'tools-bucket'});
  assert.deepEqual(plan.unresolved, []);
  assert.equal(plan.candidates.filter(p => p.prefix === workspace.storagePrefix).length, 1);
  assert.ok(plan.candidates.find(p => p.prefix === workspace.storagePrefix).roles.includes('session-workspace'));
  for (const prefix of ['custom/.mapache-internal/home', 'custom/.mapahce-internal/home', 'trees/generation', 'old/home']) assert.ok(plan.candidates.some(p => p.prefix === prefix));
  assert.match(plan.candidates.find(p => p.roles.includes('owner-tools')).prefix, /^mapache-user-tools\/[a-f0-9]{64}\/\.mapache-internal\/tools$/);
  assert.ok(storageCandidates({workspace, sessions: []}).unresolved.includes('owner-tools_descriptor_unresolved'));
  const invalid = storageCandidates({workspace: {...workspace, storagePrefix: '../escape'}, sessions: []});
  assert.ok(invalid.unresolved.includes('workspace_descriptor_unresolved'));
});

test('paginated metadata classifies both internal spellings without exposing names or claiming payload recovery', async () => {
  const requests = [];
  const result = await inventoryStorageMetadata({candidates: [candidate], unresolved: [], maxObjects: 10,
    listPage: async request => {
      requests.push(request);
      return request.pageToken ? {objects: [object(`${candidate.prefix}/.mapahce-internal/home/home.tar.gz`, 20)], nextPageToken: null} :
        {objects: [object(`${candidate.prefix}/private-name.txt`), object(`${candidate.prefix}/.mapache-internal/chrome-profile-seeds/v1/current.json`),
          object(`${candidate.prefix}/.mapache-internal/workspace-git.tar.gz`)], nextPageToken: 'page2'};
    }});
  assert.equal(requests.length, 2); assert.equal(requests[0].prefix, `${candidate.prefix}/`);
  const source = result.sources[0];
  assert.equal(source.status, 'listed-payloads-unverified'); assert.equal(source.objects, 4); assert.equal(source.storedBytes, 50);
  assert.equal(source.categories['home-archive'].objects, 1);
  assert.equal(source.categories['browser-seed-pointer'].objects, 1);
  assert.equal(source.categories['private-git-archive'].objects, 1);
  assert.equal(source.legacyInternalObjects, 1);
  assert.ok(!JSON.stringify(result).includes('private-name.txt'));
  assert.equal(result.sourceTotalsMayOverlap, true);
});

test('object limits report truncation and do not silently scan another source', async () => {
  let calls = 0;
  const result = await inventoryStorageMetadata({candidates: [candidate, {...candidate, prefix: 'second'}], unresolved: [], maxObjects: 1,
    listPage: async () => { calls++; return {objects: [object(`${candidate.prefix}/one`)], nextPageToken: 'more'}; }});
  assert.equal(calls, 1);
  assert.deepEqual(result.sources.map(s => s.status), ['budget-exhausted', 'budget-exhausted']);
});

test('access failures, repeated cursors and invalid metadata remain explicit and sanitized', async () => {
  const inspect = listPage => inventoryStorageMetadata({candidates: [candidate], unresolved: [], maxObjects: 10, listPage});
  const denied = await inspect(async () => { throw Object.assign(Error('private-url-token'), {code: 403}); });
  assert.equal(denied.sources[0].reason, 'storage_access_denied');
  assert.ok(!JSON.stringify(denied).includes('private-url'));
  const stalled = await inspect(async () => ({objects: [], nextPageToken: 'same'}));
  assert.equal(stalled.sources[0].reason, 'metadata_pagination_stalled');
  const foreign = await inspect(async () => ({objects: [object('another-prefix/file')]}));
  assert.equal(foreign.sources[0].reason, 'invalid_object_metadata');
});

test('browser pointer selects only the owned versioned object and never implies archive content verification', async () => {
  const descriptor = {schemaVersion: 1, kind: 'mapache-chrome-profile-seed', sourceWorkspaceId: 'workspace', seedVersion: 'version-123',
    bucketName: workspace.bucket, objectPath: `${workspace.storagePrefix}/.mapache-internal/chrome-profile-seeds/v1/versions/version-123/profile.tar.gz`,
    objectGeneration: '456', byteLength: 123, sha256: 'a'.repeat(64), capturedAt: '2026-11-23T00:00:00Z'};
  let reads = 0;
  const inspect = () => inspectBrowserSeedMetadata({workspaceId: 'workspace', workspacePrefix: workspace.storagePrefix, bucketName: workspace.bucket,
    readPointer: async () => ({content: Buffer.from(JSON.stringify(descriptor)), generation: '123'}),
    readObjectMetadata: async ref => { reads++; assert.equal(ref.generation, '456'); return {generation: '456', size: '123'}; }});
  const good = await inspect(); assert.equal(good.status, 'descriptor-verified-payload-unverified'); assert.equal(reads, 1);
  descriptor.sourceWorkspaceId = 'foreign';
  assert.equal((await inspect()).reason, 'browser_seed_descriptor_invalid'); assert.equal(reads, 1);
  descriptor.sourceWorkspaceId = 'workspace'; descriptor.byteLength = 100;
  assert.equal((await inspect()).reason, 'browser_seed_object_mismatch');
});
