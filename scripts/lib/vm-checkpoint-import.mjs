import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {checkpointPayloadGroups, verifyCheckpointPayloads} from './vm-checkpoint-payloads.mjs';
import {openImportStage, stageImportObject} from './vm-import-stage.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(code); };
const relative = value => typeof value === 'string' && value && !/[\\\0]/.test(value) && !value.split('/').some(p => !p || p === '.' || p === '..');
const agentKinds = {sessions: 'pi-transcript', pi: 'pi-setting', ui: 'ui-state', uploads: 'attachment'};
function destination(name, agent) {
  if (!relative(name)) fail('import_path_invalid');
  if (!agent) return `workspace/${name}`;
  const [root, ...rest] = name.split('/');
  if (!agentKinds[root] || !rest.length) fail('import_agent_path_invalid');
  return `agent/${root === 'uploads' ? 'ui/uploads' : root}/${rest.join('/')}`;
}

// expected identity/prefix/bucket must come from the owned published source
// registry, never from the downloaded manifest itself. This is not a cutover.
export async function planCheckpointImport({content, manifestRef, expected, readObjectMetadata}) {
  if (!Buffer.isBuffer(content) || content.length > 16 * 1024 * 1024 || content.length !== manifestRef.byteLength ||
      digest(content) !== manifestRef.sha256 || !/^[1-9][0-9]*$/.test(manifestRef.generation || '') ||
      typeof expected.bucketName !== 'string' || !expected.bucketName || manifestRef.bucketName !== expected.bucketName) fail('import_manifest_reference_invalid');
  const manifest = JSON.parse(content);
  if (!['workspaceId', 'sessionId', 'bootInstanceId'].every(key => typeof expected[key] === 'string' && expected[key] && manifest[key] === expected[key]) ||
      typeof expected.ownerUid !== 'string' || !expected.ownerUid || !Number.isSafeInteger(expected.generation) || expected.generation < 1 ||
      manifest.generation !== expected.generation || !relative(expected.storagePrefix) || manifest.storagePrefix !== expected.storagePrefix ||
      manifest.manifestVersion !== 1 || !Array.isArray(manifest.files) ||
      !['mapache-agent-state-snapshot', 'mapache-workspace-file-state'].includes(manifest.kind)) fail('import_manifest_identity_invalid');
  const groups = checkpointPayloadGroups({manifest, manifestRef});
  const agent = manifest.kind === 'mapache-agent-state-snapshot';
  const seen = new Set();
  const entries = manifest.files.map(file => {
    const target = destination(file.path, agent);
    if (seen.has(target)) fail('import_destination_conflict');
    seen.add(target);
    if (file.kind === 'symlink') {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), file.target));
      return {path: target, kind: 'symlink', target: path.posix.relative(path.posix.dirname(target), destination(resolved, agent))};
    }
    if ((agent ? agentKinds[file.path.split('/')[0]] : 'workspace-file') !== file.kind ||
        !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) fail('import_file_metadata_invalid');
    const bundled = file.storage === 'workspace-bundle-v1';
    return {path: target, kind: 'file', mode: file.mode, byteLength: file.byteLength, sha256: file.sha256,
      objectPath: bundled ? file.bundle.objectPath : file.objectPath, offset: bundled ? file.bundleOffset : 0};
  });
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== '.') {
      if (seen.has(parent)) fail('import_destination_conflict');
      parent = path.posix.dirname(parent);
    }
  }
  const tombstones = new Set();
  for (const name of manifest.tombstones || []) {
    const target = destination(name, agent);
    if (tombstones.has(target) || seen.has(target)) fail('import_tombstone_conflict');
    tombstones.add(target);
  }
  const objects = [];
  for (const [objectPath, descriptor] of groups) {
    const metadata = await readObjectMetadata({bucketName: expected.bucketName, objectPath});
    const generation = String(metadata.generation);
    if (!/^[1-9][0-9]*$/.test(generation) || Number(metadata.size) !== descriptor.byteLength) fail('import_object_metadata_invalid');
    objects.push({bucketName: expected.bucketName, objectPath, generation, byteLength: descriptor.byteLength, sha256: descriptor.sha256});
  }
  const document = {schemaVersion: 1, ownerUid: expected.ownerUid, workspaceId: expected.workspaceId,
    manifestRef: {...manifestRef}, manifest, entries, tombstones: [...tombstones], objects};
  return {document, sha256: digest(JSON.stringify(document))};
}

export async function stageCheckpointImport({root, operationId, plan, openSource, maxBytes}) {
  const document = plan.document;
  if (document?.schemaVersion !== 1 || digest(JSON.stringify(document)) !== plan.sha256) fail('import_plan_changed');
  const requiredBytes = document.objects.reduce((sum, object) => sum + object.byteLength, 0);
  if (!Number.isSafeInteger(requiredBytes) || !Number.isSafeInteger(maxBytes) || requiredBytes > maxBytes) fail('import_budget_exceeded');
  const stage = await openImportStage({root, operationId, ownerUid: document.ownerUid, workspaceId: document.workspaceId, sourcePlanSha256: plan.sha256});
  const staged = new Map();
  const result = await verifyCheckpointPayloads({manifest: document.manifest, manifestRef: document.manifestRef,
    budget: {remaining: maxBytes}, openObject: async ({objectPath}) => {
      const descriptor = document.objects.find(object => object.objectPath === objectPath);
      if (!descriptor) fail('import_plan_object_missing');
      const object = await stageImportObject({stage, descriptor, openSource, maxBytes});
      staged.set(objectPath, object);
      const handle = await fs.open(path.join(stage.root, 'objects', object.key), constants.O_RDONLY | constants.O_NOFOLLOW);
      return {generation: descriptor.generation, stream: handle.createReadStream()};
    }});
  if (result.status !== 'verified') fail(result.reason);
  return {stage, sourcePlanSha256: plan.sha256, entries: document.entries.map(entry => entry.kind === 'symlink' ? {...entry} :
    {...entry, stagedObjectKey: staged.get(entry.objectPath).key}), verifiedBytes: result.verifiedBytes, objects: result.objects,
  scope: 'checkpoint payloads staged and bundle slices verified; filesystem assembly and cutover not performed'};
}
