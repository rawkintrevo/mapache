import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import tar from 'tar-stream';
import {stageArchiveImport} from './vm-archive-import.mjs';
import {plainDirectory, readPlain, publishRecord, syncDirectory} from './vm-import-stage.mjs';
import {verifyEntry} from './vm-import-tree.mjs';

const fail = code => { throw Error(code); };
async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function checkDirectory(file, mode, complete) {
  const stat = await fs.lstat(file);
  if (!stat.isDirectory() || stat.uid !== process.getuid() ||
      ((stat.mode & 0o7777) !== mode && (complete || (stat.mode & 0o7777) !== 0o700))) fail('archive_tree_directory_changed');
}
async function checkMember(root, entry) {
  await verifyEntry(path.join(root, entry.path), entry);
  if (entry.kind === 'hardlink') {
    const a = await fs.lstat(path.join(root, entry.path));
    const b = await fs.lstat(path.join(root, entry.target));
    if (!b.isFile() || a.ino !== b.ino || a.dev !== b.dev) fail('archive_tree_hardlink_changed');
  }
}
async function inspect(root, entries, directories, complete) {
  const found = new Set();
  async function walk(prefix) {
    for (const name of await fs.readdir(path.join(root, prefix))) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (directories.has(relative)) {
        await checkDirectory(path.join(root, relative), directories.get(relative), complete);
        await walk(relative);
      } else {
        const entry = entries.get(relative);
        if (!entry) fail('archive_tree_unexpected_entry');
        await checkMember(root, entry);
      }
      found.add(relative);
    }
  }
  await walk('');
  if (complete && [...entries.keys(), ...directories.keys()].some(name => !found.has(name))) fail('archive_tree_missing_entry');
}

export async function assembleArchiveTree({staged, maxCompressedBytes, maxExpandedBytes, maxEntries, afterPublish = async () => {}}) {
  const {stage, document} = staged;
  if (await fs.realpath(stage.root) !== stage.root) fail('archive_tree_root_invalid');
  await plainDirectory(stage.root);
  const identity = JSON.parse(await readPlain(path.join(stage.root, 'identity.json'), 8192));
  const fresh = await stageArchiveImport({root: stage.root, ...document.sourcePlan, operationId: identity.operationId,
    maxCompressedBytes, maxExpandedBytes, maxEntries, openSource: () => fail('archive_tree_staged_source_missing')});
  if (JSON.stringify(fresh.document) !== JSON.stringify(document) || fresh.stage.identitySha256 !== stage.identitySha256) fail('archive_tree_plan_changed');
  const entries = new Map(document.entries.filter(e => e.kind !== 'directory').map(e => [e.path, e]));
  const directories = new Map(document.entries.filter(e => e.kind === 'directory').map(e => [e.path, e.mode]));
  for (const entry of document.entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== '.') { if (!directories.has(parent)) directories.set(parent, 0o700); parent = path.posix.dirname(parent); }
  }
  const tree = path.join(stage.root, 'tree'); const partials = path.join(stage.root, 'tree-partials');
  for (const name of [tree, partials]) {
    try { await fs.mkdir(name, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await plainDirectory(name);
  }
  await syncDirectory(stage.root);
  const receiptPath = path.join(stage.root, 'archive-tree.json');
  const completed = await exists(receiptPath);
  await inspect(tree, entries, directories, completed);
  const orderedDirectories = [...directories].sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const [name, mode] of orderedDirectories) {
    const target = path.join(tree, name);
    if (!await exists(target)) { await fs.mkdir(target, {mode: 0o700}); await syncDirectory(path.dirname(target)); }
    await checkDirectory(target, mode, completed);
  }
  if (!completed) {
    const extract = tar.extract(); const seen = new Set();
    extract.on('entry', (header, body, next) => {
      body.on('error', error => extract.destroy(error));
      (async () => {
        const member = path.posix.normalize(header.name).replace(/\/$/, '');
        const name = member === '.' ? document.sourcePlan.destination : `${document.sourcePlan.destination}/${member}`;
        const entry = entries.get(name);
        if (seen.has(name) || (!entry && !directories.has(name))) fail('archive_tree_source_changed');
        seen.add(name);
        if (header.type !== 'file') { for await (const _chunk of body) {} return; }
        if (entry?.kind !== 'file' || header.size !== entry.byteLength || header.mode !== entry.mode) fail('archive_tree_source_changed');
        const target = path.join(tree, name);
        if (await exists(target)) { await checkMember(tree, entry); for await (const _chunk of body) {} return; }
        const temporary = path.join(partials, randomUUID());
        const output = await fs.open(temporary, 'wx', 0o600);
        try {
          const hash = createHash('sha256'); let size = 0;
          for await (const chunk of body) {
            size += chunk.length; if (size > entry.byteLength) fail('archive_tree_source_changed');
            hash.update(chunk); await output.writeFile(chunk);
          }
          if (size !== entry.byteLength || hash.digest('hex') !== entry.sha256) fail('archive_tree_source_changed');
          await output.chmod(entry.mode); await output.sync(); await output.close();
          await fs.link(temporary, target); await syncDirectory(path.dirname(target)); await afterPublish();
        } finally { await output.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
      })().then(next, error => extract.destroy(error));
    });
    const descriptor = document.sourcePlan.descriptor;
    const input = await fs.open(path.join(stage.root, 'objects', document.archiveObjectKey), constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'); let compressed = 0; let expanded = 0;
    const sourceLimit = new Transform({transform(chunk, _encoding, done) {
      compressed += chunk.length;
      if (compressed > descriptor.byteLength) return done(Error('archive_tree_source_changed'));
      hash.update(chunk); done(null, chunk);
    }});
    const expansionLimit = new Transform({transform(chunk, _encoding, done) {
      expanded += chunk.length;
      done(expanded > fresh.summary.expandedBytes ? Error('archive_tree_source_changed') : null, chunk);
    }});
    await pipeline(input.createReadStream(), sourceLimit, createGunzip(), expansionLimit, extract);
    if (compressed !== descriptor.byteLength || hash.digest('hex') !== descriptor.sha256 ||
        seen.size !== document.entries.length) fail('archive_tree_source_changed');
    for (const entry of entries.values()) {
      if (entry.kind === 'file') continue;
      const target = path.join(tree, entry.path);
      if (!await exists(target)) {
        if (entry.kind === 'symlink') await fs.symlink(entry.target, target);
        else await fs.link(path.join(tree, entry.target), target);
        await syncDirectory(path.dirname(target)); await afterPublish();
      }
      await checkMember(tree, entry);
    }
    // Apply restrictive directory modes only after all descendants are installed.
    for (const [name, mode] of [...orderedDirectories].reverse()) {
      const handle = await fs.open(path.join(tree, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
    }
  }
  await inspect(tree, entries, directories, true);
  const receipt = {schemaVersion: 1, sourcePlanSha256: document.sourcePlanSha256, files: document.entries.filter(e => e.kind === 'file').length,
    directories: directories.size, hardlinks: document.entries.filter(e => e.kind === 'hardlink').length,
    symlinks: document.entries.filter(e => e.kind === 'symlink').length,
    ...(document.sourcePlan.prefixCapture ?
      {archivePlanSha256: createHash('sha256').update(JSON.stringify(document)).digest('hex')} : {}),
    scope: 'selected archive tree verified; not application validation or complete machine cutover'};
  await publishRecord(stage.root, 'archive-tree.json', Buffer.from(JSON.stringify(receipt)));
  return receipt;
}
