import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {verifyCheckpointPayloads} from './vm-checkpoint-payloads.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const prefix = 'workspaces/owner/workspace/.mapache-internal/agent-state';
const base = `${prefix}/workspace-files/capture`;
const manifestRef = {bucketName: 'bucket', objectPath: `${base}/manifest.json`};

function fixture() {
  const bundle = Buffer.from('firstsecond');
  const descriptor = {id: '000001', byteLength: bundle.length, sha256: digest(bundle), objectPath: `${base}/bundles/000001-${digest(bundle)}`};
  const large = Buffer.from('large-file-content');
  const regular = Buffer.from('regular');
  const files = [
    {path: 'a', byteLength: 5, sha256: digest('first'), storage: 'workspace-bundle-v1', bundleOffset: 0, bundle: descriptor},
    {path: 'b', byteLength: 6, sha256: digest('second'), storage: 'workspace-bundle-v1', bundleOffset: 5, bundle: descriptor},
    {path: 'large', byteLength: large.length, sha256: digest(large), storage: 'large-file-v1', objectPath: `${prefix}/large-files/v1/sha256/${digest(large)}`},
    {path: 'regular', byteLength: regular.length, sha256: digest(regular), objectPath: `${base}/objects/regular`},
    {path: 'alias', kind: 'symlink', target: 'regular'},
  ];
  const objects = new Map([[descriptor.objectPath, bundle], [files[2].objectPath, large], [files[3].objectPath, regular]]);
  const opens = [];
  const openObject = async ref => {
    opens.push(ref.objectPath); const bytes = objects.get(ref.objectPath);
    return {generation: '1234', stream: Readable.from([bytes.subarray(0, 3), bytes.subarray(3, 7), bytes.subarray(7)])};
  };
  const manifest = {storagePrefix: prefix, files};
  return {manifest, objects, opens, run: overrides => verifyCheckpointPayloads({manifest, manifestRef, openObject, budget: {remaining: 1000}, ...overrides})};
}

test('streams ordinary/deferred files and verifies bundled slices across chunks while reading each bundle once', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.status, 'verified');
  assert.equal(result.objects, 3); assert.equal(f.opens.length, 3);
  assert.equal(result.verifiedBytes, [...f.objects.values()].reduce((n, b) => n + b.length, 0));
  assert.match(result.objectEvidenceSha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result).includes('regular'));
});
test('whole-object and individual bundle slice corruption fail verification', async () => {
  const f = fixture(); f.manifest.files[0].sha256 = digest('wrong');
  assert.deepEqual(await f.run(), {status: 'blocked', reason: 'payload_checksum_mismatch'});
  const g = fixture(); g.objects.set(g.manifest.files[3].objectPath, Buffer.from('corrupt'));
  assert.equal((await g.run()).reason, 'payload_checksum_mismatch');
});
test('bounds, namespaces, missing targets, cycles and budget are checked before reading', async () => {
  for (const change of [f => { f.manifest.files[0].bundleOffset = 100; },
    f => { f.manifest.files[1].path = f.manifest.files[0].path; },
    f => { f.manifest.files[2].objectPath = 'other-owner/large'; },
    f => { f.manifest.files[4].target = '../escape'; },
    f => { f.manifest.files[4].target = 'alias'; }]) {
    const f = fixture(); change(f); assert.equal((await f.run()).status, 'blocked'); assert.equal(f.opens.length, 0);
  }
  const f = fixture(); assert.equal((await f.run({budget: {remaining: 1}})).reason, 'payload_budget_exceeded'); assert.equal(f.opens.length, 0);
});
test('truncated/oversized data and unreadable streams never pass or expose raw errors', async () => {
  for (const bytes of [Buffer.from('short'), Buffer.alloc(12)]) {
    const f = fixture(); f.objects.set(f.manifest.files[0].bundle.objectPath, bytes);
    assert.equal((await f.run()).reason, 'payload_size_mismatch');
  }
  const f = fixture();
  const result = await f.run({openObject: async () => ({generation: '123', stream: Readable.from((async function* () { throw Error('private-object-and-token'); })())})});
  assert.deepEqual(result, {status: 'blocked', reason: 'payload_unavailable'});
});
