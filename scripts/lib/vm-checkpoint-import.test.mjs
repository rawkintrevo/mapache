import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {spawn, execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {planCheckpointImport, stageCheckpointImport} from './vm-checkpoint-import.mjs';
import {assembleCheckpointTree} from './vm-import-tree.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const prefix = 'workspace/owner/id/.mapache-internal/agent-state';
  const base = `${prefix}/workspace-files/1/boot/capture`;
  const bundleBytes = Buffer.from('firstsecond');
  const bundle = {id: '000001', objectPath: `${base}/bundles/000001-${digest(bundleBytes)}`, byteLength: 11, sha256: digest(bundleBytes)};
  const large = Buffer.from('#!/bin/sh\nprintf restored-tool\n');
  const ordinary = Buffer.from('regular');
  const manifest = {manifestVersion: 1, kind: 'mapache-workspace-file-state', workspaceId: 'id', sessionId: 'session',
    generation: 1, bootInstanceId: 'boot', storagePrefix: prefix, files: [
      {kind: 'workspace-file', path: 'bin/tool', mode: 0o755, storage: 'large-file-v1', objectPath: `${prefix}/large-files/v1/sha256/${digest(large)}`, byteLength: large.length, sha256: digest(large)},
      {kind: 'workspace-file', path: 'a', mode: 0o640, storage: 'workspace-bundle-v1', bundle, bundleOffset: 0, byteLength: 5, sha256: digest('first')},
      {kind: 'workspace-file', path: 'b', mode: 0o600, storage: 'workspace-bundle-v1', bundle, bundleOffset: 5, byteLength: 6, sha256: digest('second')},
      {kind: 'workspace-file', path: 'normal', mode: 0o644, objectPath: `${base}/objects/normal`, byteLength: ordinary.length, sha256: digest(ordinary)},
      {kind: 'symlink', path: 'alias', target: 'bin/tool'},
    ], tombstones: ['removed']};
  const objects = new Map([[manifest.files[0].objectPath, large], [bundle.objectPath, bundleBytes], [manifest.files[3].objectPath, ordinary]]);
  const expected = {ownerUid: 'owner', workspaceId: 'id', sessionId: 'session', generation: 1, bootInstanceId: 'boot', storagePrefix: prefix, bucketName: 'bucket'};
  let reads = 0;
  const plan = overrides => {
    const content = Buffer.from(JSON.stringify(manifest));
    return planCheckpointImport({content, manifestRef: {bucketName: 'bucket', objectPath: `${base}/manifest.json`, generation: '456', byteLength: content.length, sha256: digest(content)},
      expected, readObjectMetadata: async ({objectPath}) => { reads++; return {generation: '123', size: objects.get(objectPath).length}; }, ...overrides});
  };
  return {manifest, objects, expected, plan, get reads() { return reads; }};
}
async function directory(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-checkpoint-import-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  return path.join(parent, 'stage');
}
test('stages all three storage formats once, verifies bundle slices and maps actual large-file bytes', async t => {
  const f = fixture(); const plan = await f.plan(); const root = await directory(t); const opens = [];
  const run = openSource => stageCheckpointImport({root, operationId: 'op', plan, maxBytes: 1000, openSource});
  const result = await run(async descriptor => {
    opens.push(descriptor); assert.equal(descriptor.generation, '123');
    return {generation: '123', stream: Readable.from([f.objects.get(descriptor.objectPath)])};
  });
  assert.equal(opens.length, 3); assert.equal(result.objects, 3);
  for (const [name, expected] of [['a', 'first'], ['b', 'second'], ['bin/tool', '#!/bin/sh\nprintf restored-tool\n'], ['normal', 'regular']]) {
    const entry = result.entries.find(entry => entry.path === `workspace/${name}`);
    const bytes = await fs.readFile(path.join(root, 'objects', entry.stagedObjectKey));
    assert.equal(bytes.subarray(entry.offset, entry.offset + entry.byteLength).toString(), expected);
  }
  assert.equal(result.entries[0].mode, 0o755);
  assert.deepEqual(result.entries.at(-1), {path: 'workspace/alias', kind: 'symlink', target: 'bin/tool'});
  assert.deepEqual(plan.document.tombstones, ['workspace/removed']);
  await run(() => assert.fail('resume must use staged sources'));
  const receipt = await assembleCheckpointTree({plan, staged: result});
  assert.equal(receipt.files, 4); assert.equal(receipt.symlinks, 1);
  assert.equal((await fs.stat(path.join(root, 'tree/workspace/bin/tool'))).mode & 0o777, 0o755);
  assert.equal((await promisify(execFile)(path.join(root, 'tree/workspace/alias'))).stdout, 'restored-tool');
  assert.equal(await fs.readFile(path.join(root, 'tree/workspace/a'), 'utf8'), 'first');
  assert.equal(await fs.readFile(path.join(root, 'tree/workspace/b'), 'utf8'), 'second');
  assert.deepEqual(await assembleCheckpointTree({plan, staged: result}), receipt);
  await fs.writeFile(path.join(root, 'tree/workspace/a'), 'wrong');
  await assert.rejects(assembleCheckpointTree({plan, staged: result}), /destination_changed/);
});
test('identity, namespaces, paths, mode and source conflicts fail before metadata reads', async () => {
  for (const mutate of [f => { f.expected.ownerUid = ''; }, f => { f.expected.workspaceId = 'foreign'; },
    f => { f.expected.storagePrefix = 'foreign'; }, f => { f.manifest.files[0].mode = 0o4755; },
    f => { f.manifest.files[0].path = '../escape'; }, f => { f.manifest.files[1].path = 'bin'; },
    f => { f.manifest.tombstones = ['normal']; }, f => { f.manifest.files[4].target = '../escape'; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.plan()); assert.equal(f.reads, 0);
  }
});
test('agent mappings retain history/settings/uploads and reject aliased destinations', async () => {
  const f = fixture(); f.manifest.kind = 'mapache-agent-state-snapshot';
  const file = f.manifest.files[3];
  f.manifest.files = [['sessions/history.jsonl', 'pi-transcript'], ['pi/settings.json', 'pi-setting'], ['ui/client-state.json', 'ui-state'], ['uploads/image', 'attachment']]
    .map(([path, kind]) => ({...file, path, kind}));
  f.manifest.tombstones = [];
  assert.deepEqual((await f.plan()).document.entries.map(e => e.path), ['agent/sessions/history.jsonl', 'agent/pi/settings.json', 'agent/ui/client-state.json', 'agent/ui/uploads/image']);
  f.manifest.files.push({...file, path: 'ui/uploads/image', kind: 'ui-state'});
  await assert.rejects(f.plan(), /destination_conflict/);
});
test('altered plan, budget excess and bad bundle slice cannot produce verified stage results', async t => {
  const f = fixture(); const plan = await f.plan(); const root = await directory(t);
  const args = {root, operationId: 'op', plan, maxBytes: 1, openSource: () => assert.fail('no download')};
  await assert.rejects(stageCheckpointImport(args), /budget_exceeded/);
  plan.document.entries[0].mode = 0o600;
  await assert.rejects(stageCheckpointImport({...args, maxBytes: 1000}), /plan_changed/);
  f.manifest.files[1].sha256 = digest('wrong');
  await assert.rejects(stageCheckpointImport({...args, plan: await f.plan(), maxBytes: 1000,
    openSource: async descriptor => ({generation: '123', stream: Readable.from([f.objects.get(descriptor.objectPath)])})}), /payload_checksum_mismatch/);
});

test('assembly resumes after process death following publication and rejects unknown files', {timeout: 5000}, async t => {
  const f = fixture(); const plan = await f.plan(); const root = await directory(t);
  const staged = await stageCheckpointImport({root, operationId: 'op', plan, maxBytes: 1000,
    openSource: async ref => ({generation: '123', stream: Readable.from([f.objects.get(ref.objectPath)])})});
  const script = `import {assembleCheckpointTree} from ${JSON.stringify(new URL('./vm-import-tree.mjs', import.meta.url).href)};
    await assembleCheckpointTree({plan:${JSON.stringify(plan)},staged:${JSON.stringify(staged)},afterPublish:async()=>{
      process.stdout.write('published\\n'); await new Promise(resolve=>setTimeout(resolve,60000));
    }});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => child.kill('SIGKILL')); const exited = once(child, 'exit');
  await once(child.stdout, 'data'); child.kill('SIGKILL'); await exited;
  await assert.rejects(fs.stat(path.join(root, 'checkpoint-tree.json')), {code: 'ENOENT'});
  assert.equal((await assembleCheckpointTree({plan, staged})).files, 4);
  await fs.writeFile(path.join(root, 'tree/unknown'), 'do not delete');
  await assert.rejects(assembleCheckpointTree({plan, staged}), /unexpected_entry/);
  assert.equal(await fs.readFile(path.join(root, 'tree/unknown'), 'utf8'), 'do not delete');
  await fs.unlink(path.join(root, 'tree/unknown'));
  await fs.rename(path.join(root, 'tree/workspace/bin'), path.join(root, 'saved-bin'));
  await fs.symlink(path.join(root, 'saved-bin'), path.join(root, 'tree/workspace/bin'));
  await assert.rejects(assembleCheckpointTree({plan, staged}), /directory_invalid/);
  assert.equal(await fs.readFile(path.join(root, 'saved-bin/tool'), 'utf8'), '#!/bin/sh\nprintf restored-tool\n');
});
