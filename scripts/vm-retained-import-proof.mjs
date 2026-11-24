#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import {importToRetainedDisk, verifyDiskMount} from './lib/vm-disk-import.mjs';
import {publishRecord} from './lib/vm-import-stage.mjs';

const require = createRequire(import.meta.url);
const {workspaceDiskName} = require('../functions/runtimeProvider.helpers.js');
const {retainedDiskMarker, prepareRetainedDisk} = require('../session-runner/lib/retainedDiskStorage.js');
const workspaceId = 'vm-import-proof-605';
const ownerUid = 'vm-proof-owner';
const operationId = 'retained-import-proof-605';
const generation = 1;
const mountRoot = '/mnt/mapache-import-proof-605';
const disk = workspaceDiskName(workspaceId);
const sourceParent = '/var/tmp/mapache-import-proof-605';
const hash = data => createHash('sha256').update(data).digest('hex');
const action = process.argv[2];
assert.ok(['seed', 'interrupt', 'resume', 'verify'].includes(action), 'invalid_action');
assert.ok(!process.argv[3] || process.argv[3] === '--captured', 'invalid_mode');
const prefixCapture = process.argv[3] === '--captured'
  ? {operationId: 'synthetic-source-capture-605', sourceGeneration: 7, sha256: hash('synthetic-source-inventory')}
  : undefined;
await verifyDiskMount(mountRoot, '/dev/disk/by-id/google-' + disk);

const fixture = [
  {name: 'workspace', file: 'workspace/bin/disposable-proof', mode: 0o755, value: '#!/bin/sh\nprintf retained-import-ok\n'},
  {name: 'agent', file: 'agent/sessions/history.jsonl', mode: 0o600, value: '{"type":"session","id":"synthetic"}\n'},
];
const sources = fixture.map(({name}) => {
  const root = path.join(sourceParent, name);
  return {kind: 'checkpoint', root, planFile: path.join(root, 'plan.json')};
});
const args = {mountRoot, workspaceId, ownerUid, generation, operationId, maxBytes: 1048576, sources, prefixCapture};

if (action === 'seed') {
  assert.ok((await fs.readdir(mountRoot)).every(name => name === 'lost+found'), 'disk_not_empty');
  await fs.mkdir(sourceParent, {mode: 0o700});
  for (const [index, {file, value, mode}] of fixture.entries()) {
    const source = sources[index];
    const target = path.join(source.root, 'tree', file);
    await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
    await fs.writeFile(target, value, {mode, flag: 'wx'});
    await fs.chmod(target, mode);
    const entry = {path: file, kind: 'file', mode, sha256: hash(value), byteLength: Buffer.byteLength(value)};
    const document = {ownerUid, workspaceId, entries: [entry], tombstones: [],
      ...(prefixCapture ? {prefixCapture: {...prefixCapture, checkpointKind: fixture[index].name}} : {})};
    const sha256 = hash(JSON.stringify(document));
    await publishRecord(source.root, 'plan.json', Buffer.from(JSON.stringify({document, sha256})));
    await publishRecord(source.root, 'identity.json', Buffer.from(JSON.stringify({ownerUid, workspaceId, sourcePlanSha256: sha256,
      ...(prefixCapture ? {operationId: prefixCapture.operationId} : {})})));
    await publishRecord(source.root, 'checkpoint-tree.json', Buffer.from(JSON.stringify({sourcePlanSha256: sha256})));
  }
  await publishRecord(mountRoot, '.mapache-vm-disk.json', Buffer.from(JSON.stringify(retainedDiskMarker(args))));
} else if (action === 'interrupt') {
  await importToRetainedDisk(args, {afterPublish() { process.kill(process.pid, 'SIGKILL'); }});
  throw Error('publication_did_not_interrupt');
} else {
  if (action === 'resume') {
    await assert.rejects(fs.stat(path.join(mountRoot, '.mapache-import-stage/disk-import-receipt.json')), {code: 'ENOENT'});
    const before = await fs.readdir(mountRoot);
    assert.equal(fixture.filter(item => before.includes(item.name)).length, 1);
  }
  const receipt = await importToRetainedDisk(args);
  assert.equal(receipt.directoriesPublished, 2);
  if (prefixCapture) {
    assert.deepEqual(receipt.prefixCapture, {...prefixCapture, components: ['agent', 'workspace']});
    assert.equal(receipt.destination.operationId, operationId);
    assert.equal(receipt.destination.diskName, disk);
  }
  const executable = path.join(mountRoot, fixture[0].file);
  assert.equal(execFileSync(executable, {encoding: 'utf8'}), 'retained-import-ok');
  assert.equal(await fs.readFile(path.join(mountRoot, fixture[1].file), 'utf8'), fixture[1].value);
  if (action === 'verify') {
    const runner = await prepareRetainedDisk({...args, root: mountRoot});
    assert.equal(runner.initialized, false);
    assert.equal(execFileSync(executable, {encoding: 'utf8'}), 'retained-import-ok');
  }
  console.log(JSON.stringify({status: 'passed', phase: action, disk, receipt, restoredExecutableRan: true,
    runnerStorageBootstrapChecked: action === 'verify'}));
}
