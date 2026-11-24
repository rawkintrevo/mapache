import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {openImportStage, plainDirectory, readPlain, stageImportObject} from './vm-import-stage.mjs';
import {assembleStagedTree, verifyEntry} from './vm-import-tree.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(code); };
const within = (name, prefix) => name === prefix || name.startsWith(prefix + '/');
const validPath = name => typeof name === 'string' && !/[\\\0]/.test(name) &&
  !name.split('/').some(part => !part || part === '.' || part === '..');
const readJson = async (file, limit = 64 * 1024 * 1024) => JSON.parse(await readPlain(file, limit));
const receipts = {
  checkpoint: 'checkpoint-tree.json',
  archive: 'archive-tree.json',
  'owner-tools': 'owner-tools-tree.json',
};

async function loadSource(source, ownerUid, workspaceId) {
  if (!Object.hasOwn(receipts, source.kind) || !path.isAbsolute(source.root) ||
      await fs.realpath(source.root) !== source.root) fail('merge_source_invalid');
  await plainDirectory(source.root);
  const identity = await readJson(path.join(source.root, 'identity.json'), 8192);
  const receipt = await readJson(path.join(source.root, receipts[source.kind]), 8192);
  if (identity.ownerUid !== ownerUid || identity.workspaceId !== workspaceId ||
      !/^[a-f0-9]{64}$/.test(identity.sourcePlanSha256 || '') ||
      receipt.sourcePlanSha256 !== identity.sourcePlanSha256) fail('merge_source_identity_mismatch');
  let entries;
  let tombstones = [];
  if (source.kind === 'archive') {
    const doc = await readJson(path.join(source.root, 'archive-plan.json'));
    if (digest(JSON.stringify(doc.sourcePlan)) !== identity.sourcePlanSha256) fail('merge_source_plan_changed');
    entries = doc.entries;
  } else {
    const plan = source.kind === 'owner-tools'
      ? (await readJson(path.join(source.root, 'owner-tools-plan.json'))).plan
      : await readJson(source.planFile);
    if (digest(JSON.stringify(plan.document)) !== identity.sourcePlanSha256) fail('merge_source_plan_changed');
    entries = plan.document.entries;
    tombstones = plan.document.tombstones || [];
  }
  const tree = path.join(source.root, 'tree');
  await plainDirectory(tree);
  return {tree, entries, tombstones, sourcePlanSha256: identity.sourcePlanSha256};
}

function mergeEntries(sources) {
  const merged = new Map();
  const tombstones = new Map();
  for (const [index, source] of sources.entries()) {
    for (const name of source.tombstones) {
      if (!validPath(name)) fail('merge_path_invalid');
      if (tombstones.has(name) && tombstones.get(name) !== index) fail('merge_tombstone_conflict');
      tombstones.set(name, index);
    }
  }
  for (const [index, source] of sources.entries()) {
    const seen = new Set();
    for (const entry of source.entries) {
      if (!validPath(entry.path) || seen.has(entry.path)) fail('merge_path_invalid');
      seen.add(entry.path);
      if (!['directory', 'file', 'symlink', 'hardlink'].includes(entry.kind)) fail('merge_kind_invalid');
      for (let ancestor = entry.path; ancestor !== '.'; ancestor = path.posix.dirname(ancestor)) {
        if (tombstones.has(ancestor) && tombstones.get(ancestor) !== index) fail('merge_tombstone_conflict');
      }
      const previous = merged.get(entry.path);
      if (previous) {
        if (previous.kind !== 'directory' || entry.kind !== 'directory' || previous.mode !== entry.mode) fail('merge_destination_conflict');
        continue;
      }
      const {path: relative, kind, mode, byteLength, sha256, target} = entry;
      if (kind === 'symlink' && (typeof target !== 'string' || !target || /[\\\0]/.test(target) || path.posix.isAbsolute(target))) fail('merge_path_invalid');
      merged.set(relative, {path: relative, kind, mode, byteLength, sha256, target, sourceIndex: index,
        ...(kind === 'file' ? {offset: 0} : {})});
    }
  }
  for (const entry of merged.values()) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== '.') {
      if (merged.has(parent) && merged.get(parent).kind !== 'directory') fail('merge_destination_conflict');
      parent = path.posix.dirname(parent);
    }
    if (entry.kind === 'hardlink') {
      const original = merged.get(entry.target);
      if (original?.kind !== 'file' || original.sourceIndex !== entry.sourceIndex) fail('merge_hardlink_invalid');
    }
    if (entry.kind === 'symlink') verifyLink(entry, merged);
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function verifyLink(entry, entries) {
  const stack = entry.path.split('/').slice(0, -1);
  const pending = entry.target.split('/');
  let hops = 0;
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!stack.length) fail('merge_symlink_escape');
      stack.pop();
      continue;
    }
    const target = entries.get([...stack, part].join('/'));
    if (target?.kind === 'symlink') {
      if (++hops > 40) fail('merge_symlink_cycle');
      pending.unshift(...target.target.split('/'));
    } else {
      stack.push(part);
    }
  }
}

async function sourceMember(source, entry) {
  const file = path.join(source.tree, entry.path);
  if (await fs.realpath(path.dirname(file)) !== path.dirname(file)) fail('merge_source_parent_changed');
  await verifyEntry(file, entry);
  if (entry.kind === 'hardlink') {
    const target = path.join(source.tree, entry.target);
    if (await fs.realpath(path.dirname(target)) !== path.dirname(target)) fail('merge_source_parent_changed');
    const a = await fs.lstat(file);
    const b = await fs.lstat(target);
    if (!b.isFile() || a.ino !== b.ino || a.dev !== b.dev) fail('merge_source_hardlink_changed');
  }
  return file;
}

// The maintenance operator supplies private stages and exclusive destination access.
export async function assembleMergedImport({root, ownerUid, workspaceId, operationId, sources, maxBytes}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
      !Array.isArray(sources) || !sources.length || !Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('merge_input_invalid');
  root = path.resolve(root);
  const loaded = [];
  for (const source of sources) loaded.push(await loadSource(source, ownerUid, workspaceId));
  if (loaded.some(source => within(root, path.dirname(source.tree)) || within(path.dirname(source.tree), root))) fail('merge_destination_overlaps_source');
  const entries = mergeEntries(loaded);
  const bytes = entries.reduce((sum, e) => sum + (e.kind === 'file' ? e.byteLength : 0), 0);
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) fail('merge_budget_exceeded');
  // Revalidate the original members before adopting a destination stage.
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      const directory = path.join(loaded[entry.sourceIndex].tree, entry.path);
      if (await fs.realpath(directory) !== directory) fail('merge_source_parent_changed');
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || (stat.mode & 0o7777) !== entry.mode) fail('merge_source_directory_changed');
    } else {
      await sourceMember(loaded[entry.sourceIndex], entry);
    }
  }
  const document = {schemaVersion: 1, ownerUid, workspaceId, entries, sources: loaded.map(s => s.sourcePlanSha256)};
  const sha256 = digest(JSON.stringify(document));
  const stage = await openImportStage({root, ownerUid, workspaceId, operationId, sourcePlanSha256: sha256});
  const stagedEntries = [];
  for (const entry of entries) {
    if (entry.kind !== 'file') { stagedEntries.push(entry); continue; }
    const source = loaded[entry.sourceIndex];
    const descriptor = {bucketName: 'local-verified-tree', objectPath: entry.path, generation: '1', byteLength: entry.byteLength, sha256: entry.sha256};
    const object = await stageImportObject({stage, descriptor, maxBytes, openSource: async () => {
      const file = await fs.open(path.join(source.tree, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      return {generation: '1', stream: file.createReadStream()};
    }});
    stagedEntries.push({...entry, stagedObjectKey: object.key});
  }
  return assembleStagedTree({plan: {document, sha256}, staged: {stage, sourcePlanSha256: sha256, entries: stagedEntries},
    receiptName: 'merged-tree.json', scope: 'selected source trees merged and verified in private staging'});
}
