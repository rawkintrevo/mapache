import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {openImportStage, stageImportObject, publishRecord} from './vm-import-stage.mjs';
import {assembleStagedTree} from './vm-import-tree.mjs';
const require = createRequire(import.meta.url);
const {CRC32C} = require('../../functions/node_modules/@google-cloud/storage');
const {userToolsStorageForOwner} = require('../../functions/userToolsStorage.service.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = reason => { throw Error(reason); };
const relative = value => typeof value === 'string' && value && !/[\\\0]/.test(value) && !value.split('/').some(p => !p || p === '.' || p === '..');
const base64 = (value, size) => typeof value === 'string' && Buffer.from(value, 'base64').length === size && Buffer.from(value, 'base64').toString('base64') === value;

export async function planOwnerToolsImport({ownerUid, workspaceId, bucketName, objects, listingComplete, maxObjects, maxBytes, openSource}) {
  if (typeof ownerUid !== 'string' || !ownerUid.trim() || typeof bucketName !== 'string' || !bucketName) fail('tools_descriptor_invalid');
  const source = userToolsStorageForOwner(ownerUid, {bucketName});
  if (typeof workspaceId !== 'string' || !workspaceId || listingComplete !== true || !Array.isArray(objects) ||
      !Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 100000 || objects.length > maxObjects ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('tools_listing_incomplete_or_invalid');
  const entries = []; const records = []; const names = new Set(); let total = 0;
  for (const metadata of [...objects].sort((a, b) => a.name.localeCompare(b.name))) {
    if (typeof metadata.name !== 'string' || !metadata.name.startsWith(source.prefix + '/')) fail('tools_namespace_invalid');
    const directory = metadata.name.endsWith('/');
    const suffix = metadata.name.slice(source.prefix.length + 1).replace(/\/$/, '');
    if ((!suffix && !directory) || (suffix && !relative(suffix))) fail('tools_path_invalid');
    const target = suffix ? `home/.local/${suffix}` : 'home/.local';
    if (names.has(target)) fail('tools_path_conflict'); names.add(target);
    const size = Number(metadata.size); const generation = String(metadata.generation);
    if (!/^(0|[1-9][0-9]*)$/.test(String(metadata.size)) || !Number.isSafeInteger(size) || size < 0 || (directory && size !== 0) || !/^[1-9][0-9]*$/.test(generation) ||
        (metadata.md5Hash && !base64(metadata.md5Hash, 16)) || (metadata.crc32c && !base64(metadata.crc32c, 4)) ||
        (!metadata.md5Hash && !metadata.crc32c)) fail('tools_metadata_invalid');
    const custom = metadata.metadata || {};
    if (Object.keys(custom).some(key => key !== 'gcsfuse_mtime') ||
        (custom.gcsfuse_mtime !== undefined && (typeof custom.gcsfuse_mtime !== 'string' || !custom.gcsfuse_mtime || custom.gcsfuse_mtime.length > 128))) fail('tools_custom_metadata_unsupported');
    total += size;
    if (!Number.isSafeInteger(total) || total > maxBytes) fail('tools_budget_exceeded');
    const record = {bucketName: source.bucketName, objectPath: metadata.name, generation, byteLength: size,
      ...(metadata.md5Hash ? {md5Hash: metadata.md5Hash} : {}), ...(metadata.crc32c ? {crc32c: metadata.crc32c} : {}),
      ...(custom.gcsfuse_mtime ? {sourceMtime: custom.gcsfuse_mtime} : {})};
    records.push(record);
    entries.push({path: target, kind: directory ? 'directory' : 'file', mode: 0o755, objectPath: metadata.name});
  }
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== '.') {
      if (byPath.has(parent) && byPath.get(parent).kind !== 'directory') fail('tools_path_conflict');
      parent = path.posix.dirname(parent);
    }
  }
  for (let index = 0; index < records.length; index++) {
    const record = records[index]; const md5 = createHash('md5'); const sha256 = createHash('sha256'); const crc = new CRC32C(); let size = 0;
    if (entries[index].kind === 'file') {
      const sourceObject = await openSource(record);
      if (String(sourceObject.generation) !== record.generation) { sourceObject.stream.destroy(); fail('tools_generation_changed'); }
      for await (const chunk of sourceObject.stream) {
        size += chunk.length; if (size > record.byteLength) fail('tools_size_mismatch');
        md5.update(chunk); crc.update(chunk); sha256.update(chunk);
      }
    }
    if (size !== record.byteLength || (record.md5Hash && md5.digest('base64') !== record.md5Hash) ||
        (record.crc32c && crc.toString() !== record.crc32c)) fail('tools_checksum_mismatch');
    record.sha256 = sha256.digest('hex');
    if (entries[index].kind === 'file') Object.assign(entries[index], {byteLength: size, sha256: record.sha256, offset: 0});
  }
  const implicit = new Set(['home/.local']);
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent.startsWith('home/.local')) { implicit.add(parent); parent = path.posix.dirname(parent); }
  }
  for (const name of implicit) if (!byPath.has(name)) entries.push({path: name, kind: 'directory', mode: 0o755, implicit: true});
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const document = {schemaVersion: 1, ownerUid: ownerUid.trim(), workspaceId, source, entries, objects: records,
    scope: 'owner-gcsfuse-v1 capture with fixed 0755 modes; not an atomic snapshot or authority switch'};
  return {document, sha256: digest(JSON.stringify(document))};
}

export async function stageOwnerToolsImport({root, operationId, plan, openSource, maxBytes}) {
  if (digest(JSON.stringify(plan.document)) !== plan.sha256) fail('tools_plan_changed');
  const {document} = plan;
  const total = document.objects.reduce((n, object) => n + object.byteLength, 0);
  if (!Number.isSafeInteger(maxBytes) || !Number.isSafeInteger(total) || total > maxBytes) fail('tools_budget_exceeded');
  const stage = await openImportStage({root, ownerUid: document.ownerUid, workspaceId: document.workspaceId, operationId, sourcePlanSha256: plan.sha256});
  const entries = [];
  const objects = new Map(document.objects.map(object => [object.objectPath, object]));
  for (const entry of document.entries) {
    if (entry.kind === 'directory') { entries.push({...entry}); continue; }
    const source = objects.get(entry.objectPath);
    const object = await stageImportObject({stage, descriptor: source, openSource, maxBytes});
    entries.push({...entry, stagedObjectKey: object.key});
  }
  await publishRecord(stage.root, 'owner-tools-plan.json', Buffer.from(JSON.stringify({plan, entries})));
  return {stage, entries, summary: {files: entries.filter(e => e.kind === 'file').length, directoryMarkers: entries.filter(e => e.kind === 'directory' && !e.implicit).length,
    implicitDirectories: entries.filter(e => e.implicit).length,
    verifiedBytes: total, sourcePlanSha256: plan.sha256, scope: 'owner tools staged; source sharing, merge and destination assembly not changed'}};
}

export async function assembleOwnerToolsTree({plan, staged, afterPublish}) {
  return assembleStagedTree({
    plan,
    staged: {...staged, sourcePlanSha256: staged.summary.sourcePlanSha256},
    afterPublish,
    receiptName: 'owner-tools-tree.json',
    scope: 'selected owner tools verified in a private tree',
  });
}
