import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {openCapturedStorage} from './vm-captured-storage.mjs';
import {stageImportObject, openImportStage, publishRecord} from './vm-import-stage.mjs';
import {assembleStagedTree} from './vm-import-tree.mjs';

const require = createRequire(import.meta.url);
const {CRC32C} = require('../../functions/node_modules/@google-cloud/storage');
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = reason => { throw Error(reason); };
const DIRECTORY_MARKER = /(?:^|\/)\.mapa(?:ch|hc)e-directory$/;
const INTERNAL_SEGMENT = new Set(['.mapache-internal', '.mapahce-internal']);
const relative = value => typeof value === 'string' && value && !/[\\\0]/.test(value) &&
  !value.split('/').some(part => !part || part === '.' || part === '..');

function addDirectory(entries, name, explicit = false) {
  if (!name) return;
  const previous = entries.get(name);
  if (previous && previous.kind !== 'directory') fail('flat_prefix_path_conflict');
  if (!previous) entries.set(name, {path: name, kind: 'directory', mode: 0o755, ...(explicit ? {} : {implicit: true})});
}

function addParents(entries, name) {
  let parent = path.posix.dirname(name);
  while (parent !== '.') {
    addDirectory(entries, parent);
    parent = path.posix.dirname(parent);
  }
}

export async function planFlatPrefixImport({capture, maxBytes, maxObjects = 100000, openSource}) {
  if (!capture || !capture.scope || typeof capture.scope.bucket !== 'string' ||
      typeof capture.scope.prefix !== 'string' || !Array.isArray(capture.rows) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
      !Number.isSafeInteger(maxObjects) || maxObjects < 1 || capture.rows.length > maxObjects ||
      typeof openSource !== 'function') fail('flat_prefix_import_input_invalid');
  const {bucket: bucketName, prefix} = capture.scope;
  const entries = new Map();
  const objects = [];
  let totalBytes = 0;
  addDirectory(entries, 'workspace', true);
  for (const row of capture.rows) {
    if (!Array.isArray(row) || row.length !== 2 || !Array.isArray(row[1]) || row[1].length !== 4) {
      fail('flat_prefix_capture_invalid');
    }
    const [objectPath, [generation, metageneration, size, crc32c]] = row;
    if (typeof objectPath !== 'string' || !objectPath.startsWith(prefix + '/') ||
        !/^[1-9][0-9]*$/.test(String(generation)) || !/^[1-9][0-9]*$/.test(String(metageneration)) ||
        !/^(0|[1-9][0-9]*)$/.test(String(size)) || !Number.isSafeInteger(Number(size)) ||
        (crc32c !== null && typeof crc32c !== 'string')) fail('flat_prefix_capture_invalid');
    const suffix = objectPath.slice(prefix.length + 1);
    if (!relative(suffix) || suffix.split('/').some(part => INTERNAL_SEGMENT.has(part))) {
      fail('flat_prefix_internal_state_unhandled');
    }
    const directory = DIRECTORY_MARKER.test(suffix);
    const targetSuffix = directory ? suffix.replace(DIRECTORY_MARKER, '') : suffix;
    if (!targetSuffix) {
      if (!directory || Number(size) !== 0) fail('flat_prefix_directory_marker_invalid');
      continue;
    }
    const target = `workspace/${targetSuffix}`;
    if (directory) {
      if (Number(size) !== 0) fail('flat_prefix_directory_marker_invalid');
      const previous = entries.get(target);
      if (previous && previous.kind !== 'directory') fail('flat_prefix_path_conflict');
      addDirectory(entries, target, true);
      addParents(entries, target);
      continue;
    }
    if (entries.has(target)) fail('flat_prefix_path_conflict');
    const byteLength = Number(size);
    totalBytes += byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) fail('flat_prefix_budget_exceeded');
    const ref = {bucketName, objectPath, generation: String(generation), byteLength};
    const source = await openSource(ref);
    const hash = createHash('sha256');
    const crc = crc32c ? new CRC32C() : null;
    let bytes = 0;
    for await (const chunk of source.stream) {
      bytes += chunk.length;
      if (bytes > byteLength) fail('flat_prefix_object_changed');
      hash.update(chunk); crc?.update(chunk);
    }
    if (bytes !== byteLength || (crc && crc.toString() !== crc32c)) fail('flat_prefix_object_changed');
    entries.set(target, {path: target, kind: 'file', mode: 0o644, objectPath, offset: 0, byteLength, sha256: hash.digest('hex')});
    addParents(entries, target);
    objects.push({...ref, sha256: entries.get(target).sha256, ...(crc32c ? {crc32c} : {})});
  }
  const orderedEntries = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  const document = {schemaVersion: 1, workspaceId: capture.workspaceId, ownerUid: capture.ownerUid,
    entries: orderedEntries, objects, scope: 'captured legacy flat prefix; internal archives require dedicated import'};
  return {document, sha256: digest(JSON.stringify(document)), totalBytes};
}

export async function stageFlatPrefixImport({root, operationId, plan, openSource, maxBytes}) {
  if (!plan || digest(JSON.stringify(plan.document)) !== plan.sha256) fail('flat_prefix_plan_changed');
  const {document} = plan;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || document.objects.reduce((sum, item) => sum + item.byteLength, 0) > maxBytes) {
    fail('flat_prefix_budget_exceeded');
  }
  const stage = await openImportStage({root, ownerUid: document.ownerUid, workspaceId: document.workspaceId,
    operationId, sourcePlanSha256: plan.sha256});
  const objects = new Map(document.objects.map(object => [object.objectPath, object]));
  const entries = [];
  for (const entry of document.entries) {
    if (entry.kind === 'directory') { entries.push({...entry}); continue; }
    const source = objects.get(entry.objectPath);
    if (!source) fail('flat_prefix_object_plan_missing');
    const staged = await stageImportObject({stage, descriptor: source, openSource, maxBytes});
    entries.push({...entry, stagedObjectKey: staged.key});
  }
  await publishRecord(stage.root, 'flat-prefix-plan.json', Buffer.from(JSON.stringify({plan, entries})));
  return {stage, entries, summary: {files: entries.filter(entry => entry.kind === 'file').length,
    directories: entries.filter(entry => entry.kind === 'directory').length, verifiedBytes: document.objects.reduce((sum, item) => sum + item.byteLength, 0),
    sourcePlanSha256: plan.sha256, scope: 'legacy flat prefix staged; internal archives and authority remain separate'}};
}

export async function assembleFlatPrefixTree({plan, staged, afterPublish}) {
  return assembleStagedTree({plan, staged: {...staged, sourcePlanSha256: staged.summary.sourcePlanSha256},
    afterPublish, receiptName: 'flat-prefix-tree.json',
    prefixCapture: plan.document.prefixCapture,
    scope: 'legacy flat prefix verified in a private tree; not a complete machine import or cutover approval'});
}

export async function importCapturedFlatPrefix({input, root, maxBytes, readCapture, storage}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    fail('flat_prefix_import_input_invalid');
  }
  const access = await openCapturedStorage({input, readCapture, storage});
  const {capture} = access;
  const plan = await planFlatPrefixImport({capture, maxBytes, openSource: access.openSource});
  plan.document.prefixCapture = {operationId: capture.operationId, sourceGeneration: capture.sourceGeneration,
    sha256: capture.sha256, checkpointKind: 'workspace'};
  plan.sha256 = digest(JSON.stringify(plan.document));
  const staged = await stageFlatPrefixImport({root, operationId: capture.operationId, plan,
    openSource: access.openSource, maxBytes});
  const receipt = await assembleFlatPrefixTree({plan, staged});
  await access.assertCurrent();
  return {captureSha256: capture.sha256, ...receipt, readyForCutover: false};
}
