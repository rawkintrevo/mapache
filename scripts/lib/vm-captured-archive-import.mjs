import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {openCapturedStorage} from './vm-captured-storage.mjs';
import {stageArchiveImport} from './vm-archive-import.mjs';
import {assembleArchiveTree} from './vm-archive-tree.mjs';

const require = createRequire(import.meta.url);
const {CRC32C} = require('../../functions/node_modules/@google-cloud/storage');
const {homeArchiveRemotePath, chromeProfileArchiveRemotePath} = require('../../session-runner/lib/workspaceArchives.service.js');
const {chromeProfileSeedPrefix, validateDescriptor} = require('../../session-runner/lib/chromeProfileSeed.service.js');
const {legacyInternalStoragePathVariants} = require('../../session-runner/lib/runtimePaths.js');
const fail = reason => { throw Error(reason); };

function selectArchivePath(remotePath, has) {
  const selected = [remotePath, ...legacyInternalStoragePathVariants(remotePath)].find(has);
  if (!selected) fail('captured_import_archive_missing');
  return selected;
}

async function verifyCapturedBytes(access, ref, maxBytes, writeChunk) {
  const pinned = access.lookup(ref);
  const byteLength = Number(pinned.size);
  if (byteLength < 1 || byteLength > maxBytes) fail('captured_import_archive_budget_exceeded');
  if (typeof pinned.crc32c !== 'string' || !/^[A-Za-z0-9+/]{6}==$/.test(pinned.crc32c)) {
    fail('captured_import_archive_checksum_unavailable');
  }
  const {stream} = await access.openSource(ref);
  const sha256 = createHash('sha256');
  const crc = new CRC32C();
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > byteLength) fail('captured_import_object_changed');
    sha256.update(chunk);
    crc.update(chunk);
    await writeChunk(chunk);
  }
  if (bytes !== byteLength || crc.toString() !== pinned.crc32c) fail('captured_import_archive_checksum_mismatch');
  return {...ref, generation: pinned.generation, byteLength, sha256: sha256.digest('hex')};
}

async function selectArchive(access, kind) {
  const {workspaceId, scope, archivePolicy} = access.capture;
  const {bucket: bucketName, prefix} = scope;
  if (kind === 'home') {
    const home = archivePolicy?.home;
    if (home?.homeMode === 'ephemeral') fail('captured_import_home_ephemeral');
    if (!home || home.homeStorageBucket !== bucketName || !home.homeStoragePrefix || !home.homeArchiveName ||
        (home.homeStoragePrefix !== prefix && !home.homeStoragePrefix.startsWith(prefix + '/')) ||
        /[/\\\0]/.test(home.homeArchiveName) ||
        ['.', '..'].includes(home.homeArchiveName)) fail('captured_import_home_scope_invalid');
    return {bucketName, objectPath: selectArchivePath(homeArchiveRemotePath({...home, homeSyncMode: home.homeMode}), access.has)};
  }
  if (archivePolicy?.ambiguousChromeSeed) fail('captured_import_browser_seed_ambiguous');
  let seed = archivePolicy?.chromeSeed;
  const pointerPath = chromeProfileSeedPrefix(prefix) + '/current.json';
  if (!seed && access.has(pointerPath)) {
    const chunks = [];
    await verifyCapturedBytes(access, {bucketName, objectPath: pointerPath}, 65536, chunk => chunks.push(chunk));
    try { seed = JSON.parse(Buffer.concat(chunks)); }
    catch { fail('captured_import_browser_seed_invalid'); }
    if (!seed) fail('captured_import_browser_seed_invalid');
  }
  if (seed) {
    try { validateDescriptor(seed, {workspaceId, prefix, bucketName}); }
    catch { fail('captured_import_browser_seed_invalid'); }
    return {bucketName, objectPath: seed.objectPath, generation: String(seed.objectGeneration), byteLength: seed.byteLength,
      sha256: seed.sha256};
  }
  return {bucketName, objectPath: selectArchivePath(chromeProfileArchiveRemotePath({prefix, chromeEnabled: true}), access.has)};
}

export async function importCapturedArchive({input, kind, root, maxCompressedBytes, maxExpandedBytes, maxEntries, readCapture, storage}) {
  if (!['home', 'browser'].includes(kind) || typeof root !== 'string' || !path.isAbsolute(root) ||
      ![maxCompressedBytes, maxExpandedBytes, maxEntries].every(value => Number.isSafeInteger(value) && value > 0)) {
    fail('captured_import_input_invalid');
  }
  const access = await openCapturedStorage({input, readCapture, storage});
  const {ownerUid, workspaceId, operationId, sourceGeneration, sha256} = access.capture;
  const destination = kind === 'home' ? 'home' : 'browser/profile';
  let descriptor = await selectArchive(access, kind);
  let openSource = access.openSource;
  let temporary;
  try {
    if (!descriptor.sha256) {
      const parent = path.dirname(root);
      if (await fs.realpath(parent) !== parent) fail('import_stage_path_invalid');
      temporary = await fs.mkdtemp(path.join(parent, '.captured-archive-'));
      const file = path.join(temporary, 'archive');
      const handle = await fs.open(file, 'wx', 0o600);
      try { descriptor = await verifyCapturedBytes(access, descriptor, maxCompressedBytes, chunk => handle.writeFile(chunk)); }
      finally { await handle.close(); }
      openSource = async () => {
        const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        return {generation: descriptor.generation, stream: input.createReadStream()};
      };
    }
    const limits = {maxCompressedBytes, maxExpandedBytes, maxEntries};
    const staged = await stageArchiveImport({root, ownerUid, workspaceId, operationId, destination, descriptor, openSource,
      prefixCapture: {operationId, sha256, sourceGeneration, archiveKind: kind}, ...limits});
    const receipt = await assembleArchiveTree({staged, ...limits});
    await access.assertCurrent();
    return {archiveKind: kind, captureSha256: sha256, ...receipt, readyForCutover: false};
  } finally {
    if (temporary) await fs.rm(temporary, {recursive: true, force: true});
  }
}
