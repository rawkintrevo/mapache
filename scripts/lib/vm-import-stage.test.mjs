import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {openImportStage, stageImportObject} from './vm-import-stage.mjs';
const content = Buffer.from('native bytes, not a deferred pointer\n');
const descriptor = {bucketName: 'bucket', objectPath: 'source/blob', generation: '123', byteLength: content.length,
  sha256: createHash('sha256').update(content).digest('hex')};
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-import-stage-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const identity = {root: path.join(parent, 'stage'), ownerUid: 'owner', workspaceId: 'workspace', operationId: 'op', sourcePlanSha256: 'a'.repeat(64)};
  const stage = await openImportStage(identity);
  return {parent, identity, stage};
}
function copy(stage, overrides = {}) {
  return stageImportObject({stage, descriptor, maxBytes: 1024,
    openSource: async () => ({generation: '123', stream: Readable.from([content.subarray(0, 3), content.subarray(3)])}), ...overrides});
}
test('publishes actual bytes and revalidates a matching journal on resume without source reads', async t => {
  const {stage, identity} = await fixture(t);
  const result = await copy(stage);
  assert.deepEqual(await fs.readFile(path.join(stage.root, 'objects', result.key)), content);
  const reopened = await openImportStage(identity);
  assert.equal((await copy(reopened, {openSource: () => assert.fail('resume downloaded verified data')})).reused, true);
  await assert.rejects(openImportStage({...identity, operationId: 'other'}), /identity_mismatch/);
  await fs.chmod(path.join(stage.root, 'objects', result.key), 0o644);
  await assert.rejects(copy(stage), /destination_changed/);
  await fs.chmod(path.join(stage.root, 'objects', result.key), 0o600);
  await fs.writeFile(path.join(stage.root, 'objects', result.key), Buffer.alloc(content.length));
  await assert.rejects(copy(stage), /destination_changed/);
});
test('corruption, generation mismatch, truncation, limits and source errors never publish a destination', async t => {
  const {stage} = await fixture(t);
  for (const overrides of [
    {maxBytes: 1},
    {openSource: async () => ({generation: '124', stream: Readable.from([content])})},
    {openSource: async () => ({generation: '123', stream: Readable.from([Buffer.alloc(content.length)])})},
    {openSource: async () => ({generation: '123', stream: Readable.from([content.subarray(1)])})},
    {openSource: async () => { throw Object.assign(Error('ENOSPC'), {code: 'ENOSPC'}); }},
  ]) {
    await assert.rejects(copy(stage, overrides));
    assert.deepEqual(await fs.readdir(path.join(stage.root, 'objects')), []);
  }
  assert.equal((await copy(stage)).reused, false);
});
test('symlinked destinations and staging aliases fail without writing outside the stage', async t => {
  const {stage, parent, identity} = await fixture(t);
  const result = await copy(stage);
  const destination = path.join(stage.root, 'objects', result.key);
  const outside = path.join(parent, 'outside'); await fs.writeFile(outside, content);
  await fs.unlink(destination); await fs.symlink(outside, destination);
  await assert.rejects(copy(stage));
  assert.deepEqual(await fs.readFile(outside), content);
  const alias = path.join(parent, 'alias'); await fs.symlink(stage.root, alias);
  await assert.rejects(openImportStage({...identity, root: alias}), /directory_invalid/);
});
test('SIGKILL during streaming leaves no final object and reopening can resume', {timeout: 5000}, async t => {
  const {stage, identity} = await fixture(t);
  const source = `
    import {openImportStage, stageImportObject} from ${JSON.stringify(new URL('./vm-import-stage.mjs', import.meta.url).href)};
    import {Readable} from 'node:stream';
    const stage = await openImportStage(${JSON.stringify(identity)});
    await stageImportObject({stage, descriptor: ${JSON.stringify(descriptor)}, maxBytes: 1024,
      openSource: async () => ({generation: '123', stream: Readable.from((async function* () {
        yield Buffer.from('nat');
        process.stdout.write('transferring\\n');
        await new Promise(resolve => setTimeout(resolve, 60000));
      })())})});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => child.kill('SIGKILL'));
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  child.kill('SIGKILL'); await exited;
  const before = await fs.readdir(path.join(stage.root, 'objects'));
  assert.ok(before.length > 0 && before.every(name => name.startsWith('.partial-')));
  const result = await copy(await openImportStage(identity));
  assert.deepEqual(await fs.readFile(path.join(stage.root, 'objects', result.key)), content);
  assert.equal((await copy(stage)).reused, true);
});
