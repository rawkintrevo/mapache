import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assembleMergedImport} from './vm-import-merge.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-import-merge-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const identity = {ownerUid: 'owner', workspaceId: 'workspace'};
  async function source(name, files, tombstones = [], links = []) {
    const root = path.join(parent, name);
    const entries = [];
    await fs.mkdir(path.join(root, 'tree'), {recursive: true, mode: 0o700});
    for (const [relative, value] of Object.entries(files)) {
      const target = path.join(root, 'tree', relative);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.writeFile(target, value, {mode: 0o600});
      entries.push({path: relative, kind: 'file', mode: 0o600, byteLength: Buffer.byteLength(value), sha256: digest(value)});
    }
    for (const link of links) {
      await fs.symlink(link.target, path.join(root, 'tree', link.path));
      entries.push({...link, kind: 'symlink'});
    }
    const document = {...identity, entries, tombstones};
    const sha256 = digest(JSON.stringify(document));
    const planFile = path.join(root, 'plan.json');
    await fs.writeFile(planFile, JSON.stringify({document, sha256}));
    await fs.writeFile(path.join(root, 'identity.json'), JSON.stringify({...identity, sourcePlanSha256: sha256}));
    await fs.writeFile(path.join(root, 'checkpoint-tree.json'), JSON.stringify({sourcePlanSha256: sha256}));
    return {root, kind: 'checkpoint', planFile};
  }
  return {source, options: {root: path.join(parent, 'dest'), ...identity, operationId: 'op', maxBytes: 100}};
}

test('combines separate sources into a verified tree and safely reopens it', async t => {
  const {source, options} = await fixture(t);
  const sources = [await source('one', {'workspace/a': 'alpha'}), await source('two', {'agent/pi/b': 'beta'})];
  const result = await assembleMergedImport({...options, sources});
  assert.equal(result.files, 2);
  assert.equal(await fs.readFile(path.join(options.root, 'tree/workspace/a'), 'utf8'), 'alpha');
  assert.equal(await fs.readFile(path.join(options.root, 'tree/agent/pi/b'), 'utf8'), 'beta');
  assert.deepEqual(await assembleMergedImport({...options, sources}), result);
  await fs.writeFile(path.join(sources[0].root, 'tree/workspace/a'), 'stale');
  await assert.rejects(assembleMergedImport({...options, sources}), /destination_changed/);
});

test('rejects path collisions, cross-source tombstones, foreign ownership and source aliasing before writes', async t => {
  const {source, options} = await fixture(t);
  const first = await source('one', {'workspace/a': 'alpha'}, ['workspace/removed']);
  for (const [index, [relative, reason]] of [
    ['workspace/a', 'merge_destination_conflict'],
    ['workspace/a/child', 'merge_destination_conflict'],
    ['workspace/removed/child', 'merge_tombstone_conflict'],
  ].entries()) {
    const second = await source('two' + index, {[relative]: 'beta'});
    await assert.rejects(assembleMergedImport({...options, sources: [first, second]}), new RegExp(reason));
  }
  await assert.rejects(assembleMergedImport({...options, ownerUid: 'foreign', sources: [first]}), /identity_mismatch/);
  await assert.rejects(assembleMergedImport({...options, root: path.join(first.root, 'tree/../nested'), sources: [first]}), /overlaps_source/);
  await assert.rejects(fs.stat(options.root), {code: 'ENOENT'});
});

test('rejects symlink traversal that only escapes after expanding another link', async t => {
  const {source, options} = await fixture(t);
  const first = await source('one', {'workspace/sub/a': 'alpha'}, [], [
    {path: 'workspace/sub/up', target: '../..'},
    {path: 'workspace/escape', target: 'sub/up/../outside'},
  ]);
  await assert.rejects(assembleMergedImport({...options, sources: [first]}), /merge_symlink_escape/);
  await assert.rejects(fs.stat(options.root), {code: 'ENOENT'});
});

test('keeps archive hard links on one inode and rejects a replaced source link', async t => {
  const {source, options} = await fixture(t);
  const first = await source('archive', {'home/a': 'alpha'});
  const member = path.join(first.root, 'tree/home/a');
  const alias = path.join(first.root, 'tree/home/b');
  await fs.link(member, alias);
  const {document} = JSON.parse(await fs.readFile(first.planFile));
  const sourcePlan = {ownerUid: options.ownerUid, workspaceId: options.workspaceId, destination: 'home'};
  const sha256 = digest(JSON.stringify(sourcePlan));
  const entries = [...document.entries, {...document.entries[0], kind: 'hardlink', path: 'home/b', target: 'home/a'}];
  await fs.writeFile(path.join(first.root, 'identity.json'), JSON.stringify({...sourcePlan, sourcePlanSha256: sha256}));
  await fs.writeFile(path.join(first.root, 'archive-tree.json'), JSON.stringify({sourcePlanSha256: sha256}));
  await fs.writeFile(path.join(first.root, 'archive-plan.json'), JSON.stringify({sourcePlan, entries}));
  const args = {...options, sources: [{kind: 'archive', root: first.root}]};
  await assembleMergedImport(args);
  const a = await fs.stat(path.join(options.root, 'tree/home/a'));
  const b = await fs.stat(path.join(options.root, 'tree/home/b'));
  assert.equal(a.ino, b.ino);
  await fs.unlink(alias);
  await fs.copyFile(member, alias);
  await assert.rejects(assembleMergedImport(args), /merge_source_hardlink_changed/);
});
