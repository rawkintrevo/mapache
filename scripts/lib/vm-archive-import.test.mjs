import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import tar from 'tar-stream';
import {stageArchiveImport} from './vm-archive-import.mjs';
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

test('archive import plan preserves empty directories, modes, raw symlink text and hardlink identity', async t => {
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
