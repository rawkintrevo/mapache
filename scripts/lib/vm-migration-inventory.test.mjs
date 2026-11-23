import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectMigrationSource} from './vm-migration-inventory.mjs';

function fixture({files = [], manifest = {}, workspace = {}, sessions = [{id: 'session', ownerUid: 'owner', status: 'stopped'}]} = {}) {
  const content = Buffer.from(JSON.stringify({manifestVersion: 1, kind: 'mapache-workspace-file-state', workspaceId: 'workspace',
    sessionId: 'session', generation: 3, bootInstanceId: 'boot', files, ...manifest}));
  const data = {ownerUid: 'owner', agentRuntimeGeneration: 3, agentRuntimeWorkspaceFiles: {captureId: 'capture', generation: 3, bootInstanceId: 'boot',
    manifest: {bucketName: 'bucket', objectPath: 'prefix/capture/manifest.json', byteLength: content.length,
      sha256: createHash('sha256').update(content).digest('hex')}}, ...workspace};
  return {data, content, inspect: overrides => inspectMigrationSource({workspaceId: 'workspace', workspace: data, sessions,
    readManifest: async () => ({content, objectGeneration: '123'}), ...overrides})};
}

test('inventory identifies per-file, bundle, deferred large files and symlinks without claiming payload recovery', async () => {
  const f = fixture({files: [
    {path: 'normal', byteLength: 2, sha256: 'a'.repeat(64), objectPath: 'prefix/objects/normal'},
    {path: '.local/tool', byteLength: 3, sha256: 'a'.repeat(64), storage: 'workspace-bundle-v1', bundleOffset: 0, bundle: {objectPath: 'prefix/bundles/1', byteLength: 3, sha256: 'b'.repeat(64)}},
    {path: 'large', byteLength: 10000000, sha256: 'a'.repeat(64), storage: 'large-file-v1', objectPath: 'prefix/large-files/sha'},
    {path: 'link', kind: 'symlink'},
  ]});
  const result = await f.inspect();
  assert.deepEqual(result.formats, ['large-file-v1', 'per-file', 'symlink', 'workspace-bundle-v1']);
  assert.equal(result.knownLogicalBytes, 10000005);
  assert.equal(result.sources[0].validation, 'manifest-verified-payloads-unverified');
  assert.equal(result.sources[0].objectGeneration, '123');
  assert.equal(result.readyForCutover, false);
  assert.equal(result.requiredDiskSizeGb, null);
  assert.ok(!JSON.stringify(result).includes('.local/tool'));
});

test('missing, partial, corrupt and foreign manifests are blockers with no raw diagnostics', async () => {
  for (const manifest of [{workspaceId: 'foreign'}, {generation: 2}, {sessionId: 'unknown'}, {kind: 'unknown'}, {files: [{path: '../escape'}]},
    {files: [{path: 'a', storage: 'future-v2'}]}, {files: [{path: 'a', objectPath: 'a'}, {path: 'a', objectPath: 'a'}]}]) {
    const result = await fixture({manifest}).inspect();
    assert.ok(result.blockers.includes('workspace_manifest_not_verified'));
  }
  const corrupt = await fixture().inspect({readManifest: async () => ({content: Buffer.from('{}'), objectGeneration: '123'})});
  assert.equal(corrupt.sources[0].validation, 'manifest_checksum_mismatch');
  const unavailable = await fixture().inspect({readManifest: async () => { throw Error('secret-filename-and-token'); }});
  assert.ok(!JSON.stringify(unavailable).includes('secret-filename'));
  assert.ok(unavailable.blockers.includes('workspace_manifest_not_verified'));
  const missing = await fixture().inspect({readManifest: async () => { throw Error('manifest_object_not_found'); }});
  assert.equal(missing.sources[0].validation, 'manifest_object_not_found');
});

test('registry matrix accounts for never-started, live, failed-stop, Git, shared, stale and SSH sources', async () => {
  const never = await fixture({workspace: {agentRuntimeWorkspaceFiles: null}, sessions: []}).inspect();
  assert.equal(never.classification, 'never-started');
  assert.ok(never.formats.includes('legacy-flat-prefix'));
  const active = await fixture({sessions: [{id: 'session', status: 'running'}]}).inspect();
  assert.equal(active.classification, 'active');
  assert.ok(active.blockers.includes('writers_require_quiesce_and_final_capture'));
  const failed = await fixture({sessions: [{id: 'session', status: 'stop_failed'}]}).inspect();
  assert.equal(failed.classification, 'stop-failed');
  const ssh = await fixture({workspace: {source: {type: 'ssh'}}}).inspect();
  assert.equal(ssh.classification, 'excluded-ssh');
  assert.equal((await fixture({sessions: [{id: 'session', imageKey: 'pi-n64'}]}).inspect()).classification, 'excluded-n64');
  const shared = await fixture({workspace: {source: {type: 'github'}, sharedStorage: {bucketName: 'shared', storageGeneration: 'tree'}, agentRuntimeGeneration: 4}}).inspect();
  assert.ok(shared.formats.includes('git-backed')); assert.ok(shared.formats.includes('shared-gcs-tree'));
  assert.ok(shared.blockers.includes('checkpoint_predates_current_runtime_generation'));
  const foreign = await fixture({sessions: [{id: 'session', ownerUid: 'foreign'}]}).inspect();
  assert.ok(foreign.blockers.includes('session_owner_mismatch'));
});

test('inspection does not mutate inputs and exposes no credential values', async () => {
  const f = fixture({workspace: {secret: 'do-not-export'}});
  const before = structuredClone(f.data);
  const result = await f.inspect();
  assert.deepEqual(f.data, before);
  assert.ok(!JSON.stringify(result).includes('do-not-export'));
});
