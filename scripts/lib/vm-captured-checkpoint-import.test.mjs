import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import test from 'node:test';
import {importCapturedCheckpoint} from './vm-captured-checkpoint-import.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'captured-checkpoint-'));
  t.after(() => fs.rm(folder, {recursive: true, force: true}));
  const root = path.join(folder, 'stage');
  const input = {workspaceId: 'workspace', ownerUid: 'owner', operationId: 'operation'};
  const scope = {bucket: 'bucket', prefix: 'workspaces/owner/workspace'};
  const storagePrefix = scope.prefix + '/.mapache-internal/agent-snapshots/v1';
  const base = storagePrefix + '/workspace-files/7/boot/capture';
  const manifestPath = base + '/manifest.json';
  const payloadPath = base + '/objects/file';
  const bytes = Buffer.from('captured bytes');
  const manifest = Buffer.from(JSON.stringify({manifestVersion: 1, kind: 'mapache-workspace-file-state', storagePrefix,
    workspaceId: input.workspaceId, generation: 7, sessionId: 'session', bootInstanceId: 'boot',
    files: [{kind: 'workspace-file', path: 'file', mode: 0o640, objectPath: payloadPath, byteLength: bytes.length,
      sha256: sha256(bytes)}], tombstones: ['removed']}));
  const capture = {...input, sourceGeneration: 7, scope, mainSessionIds: ['session'], checkpointPointers: {
    workspace: {generation: 7, bootInstanceId: 'boot',
      manifest: {bucketName: scope.bucket, objectPath: manifestPath, byteLength: manifest.length, sha256: sha256(manifest)}},
  }};
  const provider = new Map([[manifestPath, {generation: '100', content: manifest}],
    [payloadPath, {generation: '200', content: bytes}]]);
  for (const value of provider.values()) Object.assign(value, {metageneration: '1', crc32c: 'test'});
  capture.rows = [...provider].map(([name, value]) => [name, [value.generation, value.metageneration,
    String(value.content.length), value.crc32c]]).sort(([left], [right]) => left < right ? -1 : 1);
  const refreshDigest = () => { capture.sha256 = sha256(JSON.stringify([scope.bucket, scope.prefix, capture.rows])); };
  refreshDigest();
  const opened = [];
  const storage = {bucket: name => {
    assert.equal(name, scope.bucket);
    return {file: (objectPath, {generation}) => {
      opened.push([objectPath, generation]);
      const record = provider.get(objectPath);
      return {
        getMetadata: async () => {
          if (generation !== record?.generation) throw Object.assign(Error('pinned test provider object absent'), {code: 404});
          return [{name: objectPath, generation, metageneration: record.metageneration, size: String(record.content.length),
            crc32c: record.crc32c}];
        },
        createReadStream: options => {
          assert.deepEqual(options, {decompress: false});
          return Readable.from([record.content]);
        },
      };
    }};
  }};
  const run = overrides => importCapturedCheckpoint({input, kind: 'workspace', root, maxBytes: 4096,
    readCapture: async () => capture, storage, ...overrides});
  return {run, root, manifestPath, payloadPath, provider, capture, opened, refreshDigest};
}

test('assembles a checkpoint from captured generations and binds its private plan to the receipt', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.deepEqual(f.opened, [[f.manifestPath, '100'], [f.payloadPath, '200']]);
  assert.equal(result.readyForCutover, false);
  assert.equal(await fs.readFile(path.join(f.root, 'tree/workspace/file'), 'utf8'), 'captured bytes');
  const plan = JSON.parse(await fs.readFile(path.join(f.root, 'checkpoint-plan.json')));
  assert.equal(plan.document.prefixCapture.sha256, f.capture.sha256);
  assert.equal(plan.document.prefixCapture.operationId, f.capture.operationId);
  assert.equal(plan.sha256, result.sourcePlanSha256);
  assert.deepEqual(await f.run(), result);
  assert.deepEqual(f.opened.at(-1), [f.manifestPath, '100']);
});

test('refuses unlisted objects, superseded pointers, foreign sessions and unsafe generation conversion', async t => {
  const f = await fixture(t);
  const pointer = f.capture.checkpointPointers.workspace;
  pointer.generation = 6;
  await assert.rejects(f.run(), /checkpoint_generation_mismatch/);
  assert.equal(f.opened.length, 0);
  pointer.generation = 7;
  f.capture.mainSessionIds = [];
  await assert.rejects(f.run(), /manifest_invalid/);
  f.capture.mainSessionIds = ['session'];
  const row = f.capture.rows.pop();
  f.refreshDigest();
  await assert.rejects(f.run(), /object_unlisted/);
  row[1][0] = '9007199254740993';
  f.capture.rows.push(row);
  f.refreshDigest();
  await assert.rejects(f.run(), /generation_unsupported/);
  assert.ok(f.opened.every(([name]) => name === f.manifestPath));
  await assert.rejects(fs.stat(f.root), {code: 'ENOENT'});
});

test('changed metadata and loss of the pinned generation fail without a live fallback', async t => {
  const f = await fixture(t);
  const object = f.provider.get(f.payloadPath);
  object.metageneration = '2';
  await assert.rejects(f.run(), /object_changed/);
  object.metageneration = '1';
  object.generation = '201';
  await assert.rejects(f.run(), /object_missing/);
  assert.deepEqual(f.opened.filter(([name]) => name === f.payloadPath), [[f.payloadPath, '200'], [f.payloadPath, '200']]);
  await assert.rejects(fs.stat(path.join(f.root, 'checkpoint-tree.json')), {code: 'ENOENT'});
});

test('an abort during a copy prevents a successful import result', async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(f.run({readCapture: async () => {
    if (++calls === 2) throw Error('vm_migration_prefix_capture_phase_invalid');
    return f.capture;
  }}), /prefix_capture_phase_invalid/);
});
