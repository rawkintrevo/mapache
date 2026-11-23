import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const {assertCapturedSymlinkTargets} = require('../../session-runner/lib/checkpointSymlinkPlan.js');
const hash = () => createHash('sha256');
const validHash = value => /^[a-f0-9]{64}$/.test(value || '');
const relative = value => typeof value === 'string' && value && !value.includes('\0') && !value.includes('\\') && !value.split('/').some(p => !p || p === '.' || p === '..');

export function checkpointPayloadGroups({manifest, manifestRef}) {
    const groups = new Map();
    const paths = new Set();
    if (!relative(manifest.storagePrefix) || !relative(manifestRef.objectPath) || !manifestRef.objectPath.startsWith(`${manifest.storagePrefix}/`)) throw Error('payload_namespace_invalid');
    for (const file of manifest.files) {
      if (!relative(file.path) || paths.has(file.path)) throw Error('payload_descriptor_invalid');
      paths.add(file.path);
      if (file.kind === 'symlink') {
        if (typeof file.target !== 'string' || !file.target || file.target.includes('\0') || path.posix.isAbsolute(file.target) || file.target.includes('\\')) throw Error('payload_symlink_invalid');
        continue;
      }
      const bundled = file.storage === 'workspace-bundle-v1';
      const descriptor = bundled ? file.bundle : file;
      if (!descriptor || !relative(descriptor.objectPath) || !descriptor.objectPath.startsWith(`${manifest.storagePrefix}/`) ||
          !validHash(descriptor.sha256) || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 0 ||
          !validHash(file.sha256) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0) throw Error('payload_descriptor_invalid');
      if (file.storage && !['workspace-bundle-v1', 'large-file-v1'].includes(file.storage)) throw Error('payload_storage_unsupported');
      const offset = bundled ? file.bundleOffset : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + file.byteLength > descriptor.byteLength) throw Error('payload_bundle_invalid');
      if (bundled && (descriptor.byteLength > 8 * 1024 * 1024 || file.byteLength > 1024 * 1024 ||
          !/^\d{6,12}$/.test(descriptor.id || '') || descriptor.objectPath !== `${path.posix.dirname(manifestRef.objectPath)}/bundles/${descriptor.id}-${descriptor.sha256}`)) throw Error('payload_bundle_invalid');
      if (file.storage === 'large-file-v1' && descriptor.objectPath !== `${manifest.storagePrefix}/large-files/v1/sha256/${file.sha256}`) throw Error('payload_descriptor_invalid');
      let group = groups.get(descriptor.objectPath);
      if (group && (group.byteLength !== descriptor.byteLength || group.sha256 !== descriptor.sha256)) throw Error('payload_descriptor_conflict');
      if (!group) { group = {...descriptor, files: []}; groups.set(descriptor.objectPath, group); }
      group.files.push({offset, byteLength: file.byteLength, sha256: file.sha256});
    }
    try { assertCapturedSymlinkTargets(manifest.files); } catch { throw Error('payload_symlink_invalid'); }
    return groups;
}

export async function verifyCheckpointPayloads({manifest, manifestRef, openObject, budget}) {
  try {
    const groups = checkpointPayloadGroups({manifest, manifestRef});
    const plannedBytes = [...groups.values()].reduce((sum, group) => sum + group.byteLength, 0);
    if (!Number.isSafeInteger(plannedBytes) || !Number.isSafeInteger(budget.remaining) || plannedBytes > budget.remaining) throw Error('payload_budget_exceeded');
    budget.remaining -= plannedBytes;
    const evidence = hash(); let verifiedBytes = 0;
    for (const [objectPath, group] of groups) {
      const {stream, generation} = await openObject({bucketName: manifestRef.bucketName, objectPath, byteLength: group.byteLength});
      const objectHash = hash(); const fileHashes = group.files.map(() => hash());
      let offset = 0;
      for await (const chunk of stream) {
        if (offset + chunk.length > group.byteLength) throw Error('payload_size_mismatch');
        objectHash.update(chunk);
        group.files.forEach((file, index) => {
          const start = Math.max(offset, file.offset); const end = Math.min(offset + chunk.length, file.offset + file.byteLength);
          if (end > start) fileHashes[index].update(chunk.subarray(start - offset, end - offset));
        });
        offset += chunk.length;
      }
      if (offset !== group.byteLength) throw Error('payload_size_mismatch');
      if (objectHash.digest('hex') !== group.sha256 || group.files.some((file, index) => fileHashes[index].digest('hex') !== file.sha256)) throw Error('payload_checksum_mismatch');
      evidence.update(JSON.stringify([manifestRef.bucketName, objectPath, String(generation), group.byteLength, group.sha256]));
      verifiedBytes += offset;
    }
    return {status: 'verified', objects: groups.size, verifiedBytes, objectEvidenceSha256: evidence.digest('hex')};
  } catch (error) {
    const allowed = new Set(['payload_namespace_invalid', 'payload_descriptor_invalid', 'payload_storage_unsupported', 'payload_bundle_invalid',
      'payload_descriptor_conflict', 'payload_symlink_invalid', 'payload_budget_exceeded', 'payload_size_mismatch', 'payload_checksum_mismatch',
      'payload_object_not_found', 'payload_access_denied']);
    return {status: 'blocked', reason: allowed.has(error.message) ? error.message : 'payload_unavailable'};
  }
}
