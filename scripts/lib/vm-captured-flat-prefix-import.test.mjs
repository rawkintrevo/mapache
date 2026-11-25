import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {importCapturedFlatPrefix, planFlatPrefixImport} from './vm-captured-flat-prefix-import.mjs';
import {assembleMergedImport} from './vm-import-merge.mjs';

const prefix = 'workspaces/owner/blank';
const bytes = Buffer.from('flat prefix content\n');
const row = (name, content = Buffer.alloc(0)) => [name, ['1', '1', String(content.length), null]];
const capture = rows => ({workspaceId: 'workspace', ownerUid: 'owner', operationId: 'operation', sourceGeneration: 3,
  scope: {bucket: 'bucket', prefix}, rows});

test('plans a flat prefix with directory markers and implicit parents', async () => {
  const contentPath = `${prefix}/.pi/skills/SKILL.md`;
  const rows = [
    row(`${prefix}/.mapache/.mapahce-directory`),
    row(contentPath, bytes),
  ];
  const plan = await planFlatPrefixImport({capture: capture(rows), maxBytes: 1024,
    openSource: async ref => ({generation: ref.generation, stream: Readable.from([bytes])})});
  assert.deepEqual(plan.document.entries.map(entry => [entry.path, entry.kind]), [
    ['workspace', 'directory'],
    ['workspace/.mapache', 'directory'],
    ['workspace/.pi', 'directory'],
    ['workspace/.pi/skills', 'directory'],
    ['workspace/.pi/skills/SKILL.md', 'file'],
  ]);
  assert.equal(plan.document.entries.at(-1).byteLength, bytes.length);
  assert.match(plan.sha256, /^[a-f0-9]{64}$/);
});

test('rejects internal archives, path collisions, and byte budgets', async () => {
  const openSource = async ref => ({generation: ref.generation, stream: Readable.from([bytes])});
  await assert.rejects(planFlatPrefixImport({capture: capture([row(`${prefix}/.mapache-internal/home/home.tar.gz`, bytes)]),
    maxBytes: 1024, openSource}), /flat_prefix_internal_state_unhandled/);
  await assert.rejects(planFlatPrefixImport({capture: capture([row(`${prefix}/nested/.mapahce-internal/state`, bytes)]),
    maxBytes: 1024, openSource}), /flat_prefix_internal_state_unhandled/);
  await assert.rejects(planFlatPrefixImport({capture: capture([
    row(`${prefix}/file`, bytes), row(`${prefix}/file/.mapahce-directory`),
  ]), maxBytes: 1024, openSource}), /flat_prefix_path_conflict/);
  await assert.rejects(planFlatPrefixImport({capture: capture([row(`${prefix}/file`, bytes)]),
    maxBytes: bytes.length - 1, openSource}), /flat_prefix_budget_exceeded/);
});

test('rejects changed bytes even when the pinned row size matches', async () => {
  const changed = Buffer.from('different content\n');
  await assert.rejects(planFlatPrefixImport({capture: capture([row(`${prefix}/file`, bytes)]), maxBytes: 1024,
    openSource: async ref => ({generation: ref.generation, stream: Readable.from([changed])})}), /flat_prefix_object_changed/);
});

test('stages and resumes a captured flat prefix without remote writes', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vm-flat-prefix-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const objectPath = `${prefix}/.pi/skills/SKILL.md`;
  const rows = [row(`${prefix}/.pi/.mapahce-directory`), row(objectPath, bytes)];
  const sha256 = createHash('sha256').update(JSON.stringify(['bucket', prefix, rows])).digest('hex');
  const captured = {...capture(rows), sha256};
  const content = new Map([[objectPath, bytes]]);
  let reads = 0;
  const storage = {bucket: name => ({file: (name, options = {}) => ({
    async getMetadata() {
      const data = content.get(name);
      return [{name, generation: options.generation || '1', metageneration: '1', size: String(data?.length ?? 0), crc32c: null}];
    },
    createReadStream: () => { reads++; return Readable.from([content.get(name)]); },
  })})};
  const readCapture = async () => captured;
  const result = await importCapturedFlatPrefix({input: {workspaceId: 'workspace', ownerUid: 'owner', operationId: 'operation'},
    root: path.join(parent, 'stage'), maxBytes: 1024, readCapture, storage});
  assert.equal(result.files, 1);
  assert.equal(result.readyForCutover, false);
  assert.equal(await fs.readFile(path.join(parent, 'stage/tree/workspace/.pi/skills/SKILL.md'), 'utf8'), bytes.toString());
  const merged = await assembleMergedImport({root: path.join(parent, 'merged'), ownerUid: 'owner', workspaceId: 'workspace',
    operationId: 'operation', maxBytes: 1024, prefixCapture: {operationId: 'operation', sourceGeneration: 3, sha256},
    sources: [{kind: 'flat-prefix', root: path.join(parent, 'stage')}]});
  assert.equal(merged.files, 1);
  assert.equal(await fs.readFile(path.join(parent, 'merged/tree/workspace/.pi/skills/SKILL.md'), 'utf8'), bytes.toString());
  const firstReads = reads;
  await importCapturedFlatPrefix({input: {workspaceId: 'workspace', ownerUid: 'owner', operationId: 'operation'},
    root: path.join(parent, 'stage'), maxBytes: 1024, readCapture, storage});
  assert.ok(reads > firstReads);
});
