import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import tar from 'tar-stream';
import {stageArchiveImport} from './vm-archive-import.mjs';
import {assembleArchiveTree} from './vm-archive-tree.mjs';
import {verifyGzipTar} from './vm-archive-verifier.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function archive(entries) {
  const pack = tar.pack(); const chunks = [];
  const drain = (async () => { for await (const chunk of pack) chunks.push(chunk); })();
  for (const [header, bytes = ''] of entries) pack.entry(header, bytes);
  pack.finalize(); await drain; return gzipSync(Buffer.concat(chunks));
}
const limits = {maxCompressedBytes: 1000000, maxExpandedBytes: 1000000, maxEntries: 100};
const scan = bytes => verifyGzipTar({stream: Readable.from([bytes]), byteLength: bytes.length, sha256: digest(bytes), ...limits, includeManifest: true});

test('archive extraction preserves filesystem metadata and resumes after process death', {timeout: 10000}, async t => {
  const bytes = await archive([[{name: './', type: 'directory', mode: 0o750}],
    [{name: 'empty/', type: 'directory', mode: 0o755}],
    [{name: 'bin/', type: 'directory', mode: 0o750}],
    [{name: 'bin/tool', mode: 0o755}, 'executable'],
    [{name: 'tool-link', type: 'link', linkname: 'tool-chain', mode: 0o755}],
    [{name: 'tool-chain', type: 'link', linkname: 'bin/tool', mode: 0o755}],
    [{name: 'alias', type: 'symlink', linkname: './bin/tool'}]]);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-archive-import-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const descriptor = {bucketName: 'bucket', objectPath: 'owned/profile.tar.gz', generation: '123', byteLength: bytes.length, sha256: digest(bytes)};
  const args = {root: path.join(parent, 'stage'), ownerUid: 'owner', workspaceId: 'workspace', operationId: 'op', destination: 'browser/profile', descriptor,
    ...limits, openSource: async () => ({generation: '123', stream: Readable.from([bytes])})};
  const result = await stageArchiveImport(args);
  assert.deepEqual(result.document.entries.find(e => e.path.endsWith('/empty')), {path: 'browser/profile/empty', kind: 'directory', mode: 0o755});
  assert.equal(result.document.entries.find(e => e.kind === 'symlink').target, './bin/tool');
  for (const entry of result.document.entries.filter(e => e.kind === 'hardlink')) {
    assert.equal(entry.target, 'browser/profile/bin/tool'); assert.equal(entry.sha256, digest('executable')); assert.equal(entry.mode, 0o755);
  }
  assert.equal(result.document.entries[0].mode, 0o750);
  assert.equal(result.summary.entries, 7);
  assert.ok(!JSON.stringify(result.summary).includes('tool'));
  assert.equal((await stageArchiveImport({...args, openSource: () => assert.fail('resume must not download')})).summary.reused, true);
  const script = `import {assembleArchiveTree} from ${JSON.stringify(new URL('./vm-archive-tree.mjs', import.meta.url).href)};
    await assembleArchiveTree({staged:${JSON.stringify(result)},...${JSON.stringify(limits)},afterPublish:async()=>{
      process.stdout.write('published\\n'); await new Promise(resolve=>setTimeout(resolve,60000));
    }});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => child.kill('SIGKILL')); const exited = once(child, 'exit');
  await once(child.stdout, 'data'); child.kill('SIGKILL'); await exited;
  await assert.rejects(fs.stat(path.join(args.root, 'archive-tree.json')), {code: 'ENOENT'});
  const receipt = await assembleArchiveTree({staged: result, ...limits});
  assert.equal(receipt.files, 1); assert.equal(receipt.hardlinks, 2); assert.equal(receipt.symlinks, 1);
  const tree = path.join(args.root, 'tree/browser/profile');
  assert.deepEqual(await fs.readdir(path.join(tree, 'empty')), []);
  assert.equal((await fs.stat(tree)).mode & 0o777, 0o750);
  assert.equal((await fs.stat(path.join(tree, 'empty'))).mode & 0o777, 0o755);
  const sourceStat = await fs.stat(path.join(tree, 'bin/tool'));
  for (const name of ['tool-link', 'tool-chain']) assert.equal((await fs.stat(path.join(tree, name))).ino, sourceStat.ino);
  assert.equal(await fs.readFile(path.join(tree, 'alias'), 'utf8'), 'executable');
  assert.equal(await fs.readlink(path.join(tree, 'alias')), './bin/tool');
  assert.deepEqual(await assembleArchiveTree({staged: result, ...limits}), receipt);
  await fs.chmod(path.join(tree, 'empty'), 0o700);
  await assert.rejects(assembleArchiveTree({staged: result, ...limits}), /directory_changed/);
  await fs.chmod(path.join(tree, 'empty'), 0o755);
  await fs.unlink(path.join(tree, 'tool-link'));
  await fs.copyFile(path.join(tree, 'bin/tool'), path.join(tree, 'tool-link'));
  await assert.rejects(assembleArchiveTree({staged: result, ...limits}), /hardlink_changed/);
  await assert.rejects(stageArchiveImport({...args, destination: 'home'}), /identity_mismatch/);
});

test('private archive planning rejects unsafe link resolution, dangling links and conflicting inode modes', async () => {
  for (const entries of [
    [[{name: 'missing', type: 'symlink', linkname: 'absent'}]],
    [[{name: 'cycle', type: 'symlink', linkname: 'cycle'}]],
    [[{name: 'd/', type: 'directory'}], [{name: 'd/up', type: 'symlink', linkname: '..'}], [{name: 'escape', type: 'symlink', linkname: 'd/up/../outside'}]],
    [[{name: 'file', mode: 0o755}, 'x'], [{name: 'hard', type: 'link', linkname: 'file', mode: 0o644}]],
    [[{name: 'special', mode: 0o4755}, 'x']],
  ]) assert.equal((await scan(await archive(entries))).status, 'blocked');
});
