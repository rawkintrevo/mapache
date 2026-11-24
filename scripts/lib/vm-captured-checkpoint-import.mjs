import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {planCheckpointImport, stageCheckpointImport} from './vm-checkpoint-import.mjs';
import {assembleCheckpointTree} from './vm-import-tree.mjs';
import {publishRecord} from './vm-import-stage.mjs';

const require = createRequire(import.meta.url);
const {prepareStorageCapture} = require('../../functions/vmMigrationStorageObservation.service.js');
const {agentSnapshotStoragePrefix} = require('../../session-runner/lib/agentSnapshot.service.js');
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MANIFEST_KINDS = {agent: 'mapache-agent-state-snapshot', workspace: 'mapache-workspace-file-state'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = reason => { throw Error(reason); };

export async function importCapturedCheckpoint({input, kind, root, maxBytes, readCapture, storage}) {
  if (!Object.hasOwn(MANIFEST_KINDS, kind) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('captured_import_input_invalid');
  const capture = await readCapture(input);
  const {workspaceId, ownerUid, operationId, sourceGeneration, scope, sha256, rows, checkpointPointers, mainSessionIds} = capture;
  if (workspaceId !== input.workspaceId || ownerUid !== input.ownerUid || operationId !== input.operationId) {
    fail('captured_import_identity_mismatch');
  }
  prepareStorageCapture(scope, rows, sha256);
  const objects = new Map(rows);
  const pointer = checkpointPointers?.[kind];
  const ref = pointer?.manifest;
  if (!ref) fail('captured_import_checkpoint_missing');
  if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 1 || pointer.generation !== sourceGeneration) {
    fail('captured_import_checkpoint_generation_mismatch');
  }
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 1 || ref.byteLength > MAX_MANIFEST_BYTES ||
      !/^[a-f0-9]{64}$/.test(ref.sha256 || '') || typeof ref.objectPath !== 'string') fail('captured_import_manifest_invalid');
  const storagePrefix = ['.mapache-internal', '.mapahce-internal']
    .map(internalStorageDir => agentSnapshotStoragePrefix({prefix: scope.prefix, internalStorageDir}))
    .find(prefix => ref.objectPath.startsWith(prefix + '/'));
  if (!storagePrefix) fail('captured_import_manifest_invalid');
  if (ref.byteLength > maxBytes) fail('captured_import_budget_exceeded');

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

  // The manifest comes from the recorded generation and its bytes must match
  // the Firestore pointer before they can select any other Storage objects.
  const manifestRef = {...ref, generation: lookup(ref).generation};
  const {stream} = await openSource(manifestRef);
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > manifestRef.byteLength) fail('captured_import_manifest_invalid');
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks, length);
  if (length !== manifestRef.byteLength || digest(content) !== manifestRef.sha256) fail('captured_import_manifest_invalid');
  const manifest = JSON.parse(content);
  if (manifest?.kind !== MANIFEST_KINDS[kind] || !mainSessionIds?.includes(manifest.sessionId)) fail('captured_import_manifest_invalid');
  const basePlan = await planCheckpointImport({content, manifestRef,
    expected: {workspaceId, ownerUid, sessionId: manifest.sessionId, generation: sourceGeneration, bootInstanceId: pointer.bootInstanceId,
      storagePrefix, bucketName: scope.bucket},
    readObjectMetadata: async ref => lookup(ref)});
  const document = {...basePlan.document, prefixCapture: {operationId, sha256, sourceGeneration, checkpointKind: kind}};
  const plan = {document, sha256: digest(JSON.stringify(document))};
  const staged = await stageCheckpointImport({root, operationId, plan, openSource, maxBytes: maxBytes - manifestRef.byteLength});
  await publishRecord(staged.stage.root, 'checkpoint-plan.json', Buffer.from(JSON.stringify(plan)));
  const receipt = await assembleCheckpointTree({plan, staged});

  // Local staged bytes can remain after a failure. The caller only receives a
  // success result while the same capture is still admissible for this operation.
  if ((await readCapture(input)).sha256 !== sha256) fail('captured_import_identity_mismatch');
  return {checkpointKind: kind, captureSha256: sha256, ...receipt, readyForCutover: false};
}
