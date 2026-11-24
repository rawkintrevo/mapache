import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import test from 'node:test';
import {gzipSync} from 'node:zlib';
import tar from 'tar-stream';
import {importCapturedArchive} from './vm-captured-archive-import.mjs';
import {assembleMergedImport} from './vm-import-merge.mjs';

const require = createRequire(import.meta.url);
const {CRC32C} = require('../../functions/node_modules/@google-cloud/storage');
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function archive(value) {
  const pack = tar.pack();
  pack.entry({name: 'fixture', mode: 0o640}, value);
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  return gzipSync(Buffer.concat(chunks));
}

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'captured-archive-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const input = {workspaceId: 'workspace', ownerUid: 'owner', operationId: 'operation'};
  const prefix = 'workspaces/owner/workspace';
  const capture = {...input, sourceGeneration: 4, scope: {prefix, bucket: 'bucket'},
    archivePolicy: {home: {homeMode: 'persistent', homeStorageBucket: 'bucket',
      homeStoragePrefix: prefix + '/.mapache-internal/home', homeArchiveName: 'home.tar.gz'}}};
  const provider = new Map();
  const add = (relative, bytes) => {
    const objectPath = `${prefix}/${relative}`;
    const crc = new CRC32C();
    crc.update(bytes);
    provider.set(objectPath, {generation: String(100 + provider.size), metageneration: '1',
      size: String(bytes.length), crc32c: crc.toString(), bytes});
    capture.rows = [...provider].sort(([left], [right]) => left < right ? -1 : 1).map(([name, value]) =>
      [name, [value.generation, value.metageneration, value.size, value.crc32c]]);
    capture.sha256 = sha256(JSON.stringify(['bucket', prefix, capture.rows]));
    return objectPath;
  };
  const opened = [];
  const storage = {bucket: bucket => {
    assert.equal(bucket, 'bucket');
    return {file: (name, {generation}) => {
      opened.push([name, generation]);
      const object = provider.get(name);
      return {getMetadata: async () => {
        if (!object || generation !== object.generation) throw Object.assign(Error('absent'), {code: 404});
        const {bytes, ...metadata} = object;
        return [{name, ...metadata}];
      }, createReadStream: () => Readable.from([object.bytes])};
    }};
  }};
  const run = (kind, directory = kind, overrides) => importCapturedArchive({
    input, kind, root: path.join(parent, directory), maxCompressedBytes: 4096, maxExpandedBytes: 4096, maxEntries: 20,
    readCapture: async () => capture, storage, ...overrides,
  });
  return {parent, capture, provider, opened, add, run};
}

test('HOME prefers the canonical archive and can restore the legacy spelling when it was the only captured copy', async t => {
  const f = await fixture(t);
  const legacy = f.add('.mapahce-internal/home/home.tar.gz', await archive('legacy HOME'));
  const old = await f.run('home', 'legacy');
  assert.equal(old.readyForCutover, false);
  assert.deepEqual(f.opened, [[legacy, '100']]);
  assert.equal(await fs.readFile(path.join(f.parent, 'legacy/tree/home/fixture'), 'utf8'), 'legacy HOME');
  const canonical = f.add('.mapache-internal/home/home.tar.gz', await archive('current HOME'));
  const current = await f.run('home', 'canonical');
  assert.deepEqual(f.opened.at(-1), [canonical, '101']);
  assert.equal(await fs.readFile(path.join(f.parent, 'canonical/tree/home/fixture'), 'utf8'), 'current HOME');
  const plan = JSON.parse(await fs.readFile(path.join(f.parent, 'canonical/archive-plan.json')));
  assert.equal(plan.sourcePlan.prefixCapture.sha256, current.captureSha256);
  assert.equal(plan.sourcePlan.descriptor.generation, '101');
  plan.entries = [];
  await fs.writeFile(path.join(f.parent, 'canonical/archive-plan.json'), JSON.stringify(plan));
  await assert.rejects(assembleMergedImport({root: path.join(f.parent, 'altered'), ownerUid: 'owner', workspaceId: 'workspace',
    operationId: 'disk-operation', prefixCapture: plan.sourcePlan.prefixCapture,
    sources: [{kind: 'archive', root: path.join(f.parent, 'canonical')}], maxBytes: 4096}), /merge_capture_archive_plan_changed/);
  const object = f.provider.get(canonical);
  object.bytes = Buffer.from(object.bytes);
  object.bytes[1] ^= 1;
  await assert.rejects(f.run('home', 'corrupt'), /archive_checksum_mismatch/);
  assert.deepEqual(f.opened.at(-1), [canonical, '101']);
  assert.equal((await fs.readdir(f.parent)).some(name => name.startsWith('.captured-archive-')), false);
});

test('a captured Chrome seed pointer takes precedence over the legacy archive', async t => {
  const f = await fixture(t);
  const fallback = f.add('.mapache-internal/chrome/chrome-profile.tar.gz', await archive('fallback profile'));
  const seedBytes = await archive('pinned profile');
  const seedPath = f.add('.mapache-internal/chrome-profile-seeds/v1/versions/fixture-seed/profile.tar.gz', seedBytes);
  const pointer = {schemaVersion: 1, kind: 'mapache-chrome-profile-seed', sourceWorkspaceId: 'workspace',
    seedVersion: 'fixture-seed', objectGeneration: '101', bucketName: 'bucket', objectPath: seedPath,
    byteLength: seedBytes.length, sha256: sha256(seedBytes), capturedAt: '2026-01-01T00:00:00.000Z'};
  const pointerPath = f.add('.mapache-internal/chrome-profile-seeds/v1/current.json', Buffer.from(JSON.stringify(pointer)));
  await f.run('browser');
  assert.deepEqual(f.opened, [[pointerPath, '102'], [seedPath, '101']]);
  assert.equal(await fs.readFile(path.join(f.parent, 'browser/tree/browser/profile/fixture'), 'utf8'), 'pinned profile');
  f.provider.delete(seedPath);
  await assert.rejects(f.run('browser', 'missing-seed'), /object_missing/);
  assert.ok(!f.opened.some(([name]) => name === fallback));
  f.capture.archivePolicy.chromeSeed = {...pointer, sourceWorkspaceId: 'foreign'};
  const count = f.opened.length;
  await assert.rejects(f.run('browser', 'foreign'), /browser_seed_invalid/);
  assert.equal(f.opened.length, count);
});

test('fallback browser import uses captured bytes and rechecks the operation after extraction', async t => {
  const f = await fixture(t);
  const fallback = f.add('.mapahce-internal/chrome/chrome-profile.tar.gz', await archive('profile'));
  let reads = 0;
  await assert.rejects(f.run('browser', 'profile', {readCapture: async () => {
    if (++reads > 1) throw Error('vm_migration_prefix_capture_phase_invalid');
    return f.capture;
  }}), /prefix_capture_phase_invalid/);
  assert.deepEqual(f.opened, [[fallback, '100']]);
  f.capture.archivePolicy.home.homeMode = 'ephemeral';
  await assert.rejects(f.run('home'), /home_ephemeral/);
});
