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
async function verifyEntry(target, entry) {
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
async function inspectTree(root, entries, directories, complete) {
  const found = new Set();
  async function visit(relative) {
    for (const name of await fs.readdir(path.join(root, relative))) {
      const child = relative ? `${relative}/${name}` : name;
      const target = path.join(root, child);
      if (directories.has(child)) {
        await plainDirectory(target); await visit(child);
      } else {
        const entry = entries.get(child);
        if (!entry) fail('import_tree_unexpected_entry');
        await verifyEntry(target, entry);
      }
      found.add(child);
    }
  }
  await visit('');
  if (complete && [...directories, ...entries.keys()].some(name => !found.has(name))) fail('import_tree_missing_entry');
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
  if (digest(JSON.stringify(plan.document)) !== plan.sha256 || staged.sourcePlanSha256 !== plan.sha256 ||
      JSON.stringify(staged.entries.map(({stagedObjectKey: _key, ...entry}) => entry)) !== JSON.stringify(plan.document.entries)) fail('import_tree_plan_changed');
  const stage = staged.stage;
  if (await fs.realpath(stage.root) !== stage.root) fail('import_tree_root_invalid');
  await plainDirectory(stage.root);
  const identityBytes = await readPlain(path.join(stage.root, 'identity.json'), 8192);
  const identity = JSON.parse(identityBytes);
  if (digest(identityBytes) !== stage.identitySha256 || identity.sourcePlanSha256 !== plan.sha256 ||
      identity.workspaceId !== plan.document.workspaceId || identity.ownerUid !== plan.document.ownerUid) fail('import_tree_identity_mismatch');
  const entries = new Map(staged.entries.map(entry => [entry.path, entry]));
  const directories = new Set();
  for (const entry of entries.values()) {
    if (entry.kind === 'file' && !/^[a-f0-9]{64}$/.test(entry.stagedObjectKey || '')) fail('import_tree_source_invalid');
    let parent = path.posix.dirname(entry.path);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  const tree = path.join(stage.root, 'tree');
  const partials = path.join(stage.root, 'tree-partials');
  await publishRecord(stage.root, 'tree-plan.json', Buffer.from(JSON.stringify({sourcePlanSha256: plan.sha256, entries: staged.entries})));
  await directory(tree); await directory(partials); await syncDirectory(stage.root);
  await inspectTree(tree, entries, directories, false);
  for (const relative of [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    await directory(path.join(tree, relative)); await syncDirectory(path.dirname(path.join(tree, relative)));
  }
  for (const entry of entries.values()) {
    const target = path.join(tree, entry.path);
    let exists = true;
    try { await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    if (!exists) {
      if (entry.kind === 'symlink') await fs.symlink(entry.target, target);
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
    await verifyEntry(target, entry);
  }
  await inspectTree(tree, entries, directories, true);
  const receipt = {schemaVersion: 1, sourcePlanSha256: plan.sha256, files: staged.entries.filter(e => e.kind === 'file').length,
    symlinks: staged.entries.filter(e => e.kind === 'symlink').length, directories: directories.size,
    scope: 'selected checkpoint tree verified; not a complete machine import or cutover approval'};
  await publishRecord(stage.root, 'checkpoint-tree.json', Buffer.from(JSON.stringify(receipt)));
  return receipt;
}
