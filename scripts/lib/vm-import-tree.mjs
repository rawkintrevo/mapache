import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {plainDirectory, readPlain, publishRecord, syncDirectory} from './vm-import-stage.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Error(code); };
async function directory(name) {
  try { await fs.mkdir(name, {mode: 0o700}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await plainDirectory(name);
}
export async function verifyEntry(target, entry) {
  const stat = await fs.lstat(target);
  if (entry.kind === 'symlink') {
    if (!stat.isSymbolicLink() || await fs.readlink(target) !== entry.target) fail('import_tree_destination_changed');
    return;
  }
  if (!stat.isFile() || stat.size !== entry.byteLength || (stat.mode & 0o7777) !== entry.mode) fail('import_tree_destination_changed');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({autoClose: false})) hash.update(chunk);
    if (hash.digest('hex') !== entry.sha256) fail('import_tree_destination_changed');
  } finally { await handle.close(); }
}
async function verifyDirectory(target, mode, complete) {
  const stat = await fs.lstat(target);
  const actualMode = stat.mode & 0o7777;
  if (!stat.isDirectory() || stat.uid !== process.getuid() ||
      (actualMode !== mode && (complete || actualMode !== 0o700))) fail('import_stage_directory_invalid');
}

async function verifyTreeEntry(root, entry) {
  const target = path.join(root, entry.path);
  await verifyEntry(target, entry);
  if (entry.kind === 'hardlink') {
    const stat = await fs.lstat(target);
    const original = await fs.lstat(path.join(root, entry.target));
    if (!original.isFile() || stat.dev !== original.dev || stat.ino !== original.ino) fail('import_tree_hardlink_changed');
  }
}

async function inspectTree(root, entries, directories, complete) {
  const found = new Set();
  async function visit(relative) {
    for (const name of await fs.readdir(path.join(root, relative))) {
      const child = relative ? `${relative}/${name}` : name;
      const target = path.join(root, child);
      if (directories.has(child)) {
        await verifyDirectory(target, directories.get(child), complete); await visit(child);
      } else {
        const entry = entries.get(child);
        if (!entry) fail('import_tree_unexpected_entry');
        await verifyTreeEntry(root, entry);
      }
      found.add(child);
    }
  }
  await visit('');
  if (complete && [...directories.keys(), ...entries.keys()].some(name => !found.has(name))) fail('import_tree_missing_entry');
}
async function copySlice({source, temporary, entry}) {
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || entry.offset + entry.byteLength > stat.size) fail('import_tree_source_invalid');
    output = await fs.open(temporary, 'wx', 0o600);
    const buffer = Buffer.alloc(64 * 1024); const hash = createHash('sha256'); let copied = 0;
    while (copied < entry.byteLength) {
      const {bytesRead} = await input.read(buffer, 0, Math.min(buffer.length, entry.byteLength - copied), entry.offset + copied);
      if (!bytesRead) fail('import_tree_source_truncated');
      const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); await output.writeFile(bytes); copied += bytesRead;
    }
    if (hash.digest('hex') !== entry.sha256) fail('import_tree_source_changed');
    await output.chmod(entry.mode); await output.sync();
  } finally { await input.close(); await output?.close(); }
}

// Assemble only the selected checkpoint in its owned private stage. A checkpoint
// tree is NOT a complete machine disk and cannot authorize a provider cutover.
export async function assembleCheckpointTree({plan, staged, afterPublish = async () => {}}) {
  return assembleStagedTree({plan, staged, afterPublish, receiptName: 'checkpoint-tree.json',
    scope: 'selected checkpoint tree verified; not a complete machine import or cutover approval'});
}

// Both callers supply a verified plan within an exclusively managed stage.
export async function assembleStagedTree({plan, staged, receiptName, scope, afterPublish = async () => {}}) {
  if (digest(JSON.stringify(plan.document)) !== plan.sha256 || staged.sourcePlanSha256 !== plan.sha256 ||
      JSON.stringify(staged.entries.map(({stagedObjectKey: _key, ...entry}) => entry)) !== JSON.stringify(plan.document.entries)) fail('import_tree_plan_changed');
  const stage = staged.stage;
  if (await fs.realpath(stage.root) !== stage.root) fail('import_tree_root_invalid');
  await plainDirectory(stage.root);
  const identityBytes = await readPlain(path.join(stage.root, 'identity.json'), 8192);
  const identity = JSON.parse(identityBytes);
  if (digest(identityBytes) !== stage.identitySha256 || identity.sourcePlanSha256 !== plan.sha256 ||
      identity.workspaceId !== plan.document.workspaceId || identity.ownerUid !== plan.document.ownerUid) fail('import_tree_identity_mismatch');
  const entries = new Map();
  const directories = new Map();
  for (const entry of staged.entries) {
    if (typeof entry.path !== 'string' || /[\\\0]/.test(entry.path) ||
        entry.path.split('/').some(part => !part || part === '.' || part === '..') ||
        entries.has(entry.path) || directories.has(entry.path)) fail('import_tree_path_invalid');
    if (entry.kind === 'directory') {
      if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail('import_tree_directory_mode_invalid');
      directories.set(entry.path, entry.mode);
    } else {
      if (!['file', 'symlink', 'hardlink'].includes(entry.kind)) fail('import_tree_entry_invalid');
      entries.set(entry.path, entry);
    }
    if (entry.kind === 'file' && !/^[a-f0-9]{64}$/.test(entry.stagedObjectKey || '')) fail('import_tree_source_invalid');
  }
  for (const entry of staged.entries) {
    if (entry.kind === 'hardlink') {
      const original = entries.get(entry.target);
      if (original?.kind !== 'file' || ['sha256', 'mode', 'byteLength'].some(key => original[key] !== entry[key])) fail('import_tree_hardlink_invalid');
    }
    let parent = path.posix.dirname(entry.path);
    while (parent !== '.') {
      if (entries.has(parent)) fail('import_tree_path_invalid');
      if (!directories.has(parent)) directories.set(parent, 0o700);
      parent = path.posix.dirname(parent);
    }
  }
  const tree = path.join(stage.root, 'tree');
  const partials = path.join(stage.root, 'tree-partials');
  await publishRecord(stage.root, 'tree-plan.json', Buffer.from(JSON.stringify({sourcePlanSha256: plan.sha256, entries: staged.entries})));
  await directory(tree); await directory(partials); await syncDirectory(stage.root);
  const complete = await pathExists(path.join(stage.root, receiptName));
  await inspectTree(tree, entries, directories, complete);
  const ordered = [...directories].sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const [relative, mode] of ordered) {
    const target = path.join(tree, relative);
    if (!await pathExists(target)) {
      await fs.mkdir(target, {mode: 0o700});
      await syncDirectory(path.dirname(target));
    }
    await verifyDirectory(target, mode, complete);
  }
  const leaves = [...entries.values()];
  for (const entry of [...leaves.filter(e => e.kind !== 'hardlink'), ...leaves.filter(e => e.kind === 'hardlink')]) {
    const target = path.join(tree, entry.path);
    let exists = true;
    try { await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    if (!exists) {
      if (entry.kind === 'symlink') await fs.symlink(entry.target, target);
      else if (entry.kind === 'hardlink') await fs.link(path.join(tree, entry.target), target);
      else {
        const temporary = path.join(partials, randomUUID());
        try {
          await plainDirectory(path.join(stage.root, 'objects'));
          await copySlice({source: path.join(stage.root, 'objects', entry.stagedObjectKey), temporary, entry});
          await fs.link(temporary, target);
        } finally { await fs.unlink(temporary).catch(() => {}); }
      }
      await syncDirectory(path.dirname(target));
      await afterPublish();
    }
    await verifyTreeEntry(tree, entry);
  }
  for (const [relative, mode] of ordered.reverse()) {
    const target = path.join(tree, relative);
    if (((await fs.lstat(target)).mode & 0o7777) === mode) continue;
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
  }
  await inspectTree(tree, entries, directories, true);
  const receipt = {schemaVersion: 1, sourcePlanSha256: plan.sha256, files: staged.entries.filter(e => e.kind === 'file').length,
    symlinks: staged.entries.filter(e => e.kind === 'symlink').length, directories: directories.size,
    scope};
  await publishRecord(stage.root, receiptName, Buffer.from(JSON.stringify(receipt)));
  return receipt;
}

async function pathExists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
