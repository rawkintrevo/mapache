import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {openImportStage, stageImportObject, publishRecord} from './vm-import-stage.mjs';
import {verifyGzipTar} from './vm-archive-verifier.mjs';

// The caller proves the descriptor belongs to this owner/workspace and selects
// its authority. These are the only supported archive destinations at present.
export async function stageArchiveImport({root, ownerUid, workspaceId, operationId, destination, descriptor,
  openSource, maxCompressedBytes, maxExpandedBytes, maxEntries, prefixCapture}) {
  if (!['home', 'browser/profile'].includes(destination)) throw Error('archive_destination_invalid');
  const sourcePlan = {schemaVersion: 1, ownerUid, workspaceId, destination, descriptor, ...(prefixCapture ? {prefixCapture} : {})};
  const sourcePlanSha256 = createHash('sha256').update(JSON.stringify(sourcePlan)).digest('hex');
  const stage = await openImportStage({root, ownerUid, workspaceId, operationId, sourcePlanSha256});
  const object = await stageImportObject({stage, descriptor, openSource, maxBytes: maxCompressedBytes});
  const handle = await fs.open(path.join(stage.root, 'objects', object.key), constants.O_RDONLY | constants.O_NOFOLLOW);
  const verification = await verifyGzipTar({stream: handle.createReadStream(), byteLength: descriptor.byteLength,
    sha256: descriptor.sha256, maxCompressedBytes, maxExpandedBytes, maxEntries, includeManifest: true});
  if (verification.status !== 'verified') throw Error(verification.reason);
  const mapped = name => name === '.' ? destination : `${destination}/${name}`;
  const entries = verification.privateManifest.map(entry => {
    const targetPath = mapped(entry.path);
    if (entry.type === 'directory') return {path: targetPath, kind: 'directory', mode: entry.mode};
    if (entry.type === 'symlink') return {path: targetPath, kind: 'symlink', target: entry.linkname};
    if (entry.type === 'link') return {path: targetPath, kind: 'hardlink', target: mapped(entry.target), mode: entry.mode,
      byteLength: entry.byteLength, sha256: entry.sha256};
    return {path: targetPath, kind: 'file', mode: entry.mode, byteLength: entry.byteLength, sha256: entry.sha256, archiveMember: entry.path};
  });
  const document = {sourcePlan, sourcePlanSha256, archiveObjectKey: object.key, entries};
  await publishRecord(stage.root, 'archive-plan.json', Buffer.from(JSON.stringify(document)));
  return {stage, document, summary: {compressedBytes: verification.compressedBytes, expandedBytes: verification.expandedBytes,
    entries: verification.entries, types: verification.types, reused: object.reused,
    scope: 'archive bytes staged and member manifest verified; no filesystem extraction or cutover'}};
}
