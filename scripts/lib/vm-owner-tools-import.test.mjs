import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {planOwnerToolsImport, stageOwnerToolsImport} from './vm-owner-tools-import.mjs';
const require = createRequire(import.meta.url);
const {CRC32C} = require('../../functions/node_modules/@google-cloud/storage');
const {userToolsStorageForOwner} = require('../../functions/userToolsStorage.service.js');
const source = userToolsStorageForOwner('owner', {bucketName: 'bucket'});
function metadata(name, bytes) {
  const crc = new CRC32C(); crc.update(bytes);
  return {name: source.prefix + '/' + name, size: String(bytes.length), generation: '123', md5Hash: createHash('md5').update(bytes).digest('base64'), crc32c: crc.toString()};
}
function fixture() {
  const bytes = Buffer.from('tool-data'); const empty = Buffer.alloc(0);
  return {ownerUid: 'owner', workspaceId: 'workspace', bucketName: 'bucket', listingComplete: true, maxObjects: 100, maxBytes: 1000,
    objects: [metadata('', empty), metadata('empty/', empty), metadata('bin/tool', bytes)],
    openSource: async () => ({generation: '123', stream: Readable.from([bytes])})};
}
test('owner mount semantics, empty/implicit directories and cloud checksums survive staging and resume', async t => {
  const args = fixture(); args.objects[2].metadata = {gcsfuse_mtime: '2026-11-23T00:00:00.000000001Z'};
  const plan = await planOwnerToolsImport(args);
  assert.equal(plan.document.objects.find(o => o.byteLength > 0).sourceMtime, args.objects[2].metadata.gcsfuse_mtime);
  assert.equal(plan.document.entries.find(e => e.path === 'home/.local/bin').implicit, true);
  assert.ok(plan.document.entries.every(e => e.mode === 0o755));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-tools-import-')); t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const options = {root: path.join(parent, 'stage'), operationId: 'op', plan, maxBytes: 1000, openSource: args.openSource};
  const result = await stageOwnerToolsImport(options);
  assert.equal(result.summary.files, 1); assert.equal(result.summary.directoryMarkers, 2); assert.equal(result.summary.implicitDirectories, 1);
  assert.equal(result.summary.verifiedBytes, 9);
  await stageOwnerToolsImport({...options, openSource: () => assert.fail('resume should use verified objects')});
});
test('wrong owner, incomplete listing, ambiguous metadata, conflicts and budget fail before reads', async () => {
  for (const change of [a => { a.ownerUid = 'foreign'; }, a => { a.bucketName = ''; }, a => { a.listingComplete = false; },
    a => { a.maxBytes = 1; }, a => { a.objects[2].metadata = {mapacheSymlinkTarget: 'other'}; },
    a => { delete a.objects[2].md5Hash; delete a.objects[2].crc32c; },
    a => { a.objects.push({...a.objects[2], name: source.prefix + '/bin/tool/child'}); }]) {
    const args = fixture(); change(args); let reads = 0;
    await assert.rejects(planOwnerToolsImport({...args, openSource: () => { reads++; throw Error('unexpected_read'); }}));
    assert.equal(reads, 0);
  }
});
test('CRC-only objects validate and changed generation, truncated data or corrupted cloud checksums fail', async () => {
  const crcOnly = fixture(); delete crcOnly.objects[2].md5Hash;
  assert.equal((await planOwnerToolsImport(crcOnly)).document.objects.length, 3);
  for (const change of [a => { a.objects[2].crc32c = 'AAAAAA=='; }, a => { a.objects[2].md5Hash = Buffer.alloc(16).toString('base64'); },
    a => { a.openSource = async () => ({generation: '124', stream: Readable.from(['tool-data'])}); },
    a => { a.openSource = async () => ({generation: '123', stream: Readable.from(['tool'])}); }]) {
    const args = fixture(); change(args); await assert.rejects(planOwnerToolsImport(args));
  }
});
