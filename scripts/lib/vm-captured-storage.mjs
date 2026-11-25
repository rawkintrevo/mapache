import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {prepareStorageCapture} = require('../../functions/vmMigrationStorageObservation.service.js');
const fail = reason => { throw Error(reason); };

export async function openCapturedStorage({input, readCapture, storage}) {
  const capture = await readCapture(input);
  const {workspaceId, ownerUid, operationId, scope, sha256, rows} = capture;
  if (workspaceId !== input.workspaceId || ownerUid !== input.ownerUid || operationId !== input.operationId) {
    fail('captured_import_identity_mismatch');
  }
  prepareStorageCapture(scope, rows, sha256);
  const objects = new Map(rows);
  function lookup({bucketName, objectPath, byteLength, generation}) {
    const row = objects.get(objectPath);
    if (bucketName !== scope.bucket || !row) fail('captured_import_object_unlisted');
    const [pinnedGeneration, metageneration, size, crc32c] = row;
    // The installed Storage client converts its generation option to Number.
    if (!Number.isSafeInteger(Number(pinnedGeneration))) fail('captured_import_generation_unsupported');
    if ((byteLength !== undefined && byteLength !== Number(size)) ||
        (generation !== undefined && generation !== pinnedGeneration)) fail('captured_import_object_changed');
    return {generation: pinnedGeneration, metageneration, size, crc32c};
  }

  async function openSource(ref) {
    const pinned = lookup(ref);
    const file = storage.bucket(ref.bucketName).file(ref.objectPath, {generation: pinned.generation});
    let metadata;
    try {
      [metadata] = await file.getMetadata();
    } catch (error) {
      if (Number(error.code) === 404) fail('captured_import_object_missing');
      if ([401, 403].includes(Number(error.code))) fail('captured_import_object_access_denied');
      throw error;
    }
    if (metadata.name !== ref.objectPath || String(metadata.generation) !== pinned.generation ||
        String(metadata.metageneration) !== pinned.metageneration || String(metadata.size) !== pinned.size ||
        (metadata.crc32c ?? null) !== pinned.crc32c) fail('captured_import_object_changed');
    return {generation: pinned.generation, stream: file.createReadStream({decompress: false})};
  }

  async function assertCurrent() {
    if ((await readCapture(input)).sha256 !== sha256) fail('captured_import_identity_mismatch');
  }

  return {capture, lookup, openSource, assertCurrent, has: objectPath => objects.has(objectPath)};
}
