#!/usr/bin/env node
import {execFile} from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {readRetainedDiskReceipt} from './lib/vm-disk-import.mjs';

const run = promisify(execFile);
try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 8192) throw Error('maintenance_config_invalid');
    chunks.push(chunk);
  }
  const config = JSON.parse(Buffer.concat(chunks));
  if (typeof config.diskName !== 'string' || !/^mapache-ws-[a-f0-9]{24}$/.test(config.diskName) ||
      config.projectId !== 'pi-agents-cloud') throw Error('maintenance_config_invalid');
  const metadata = async key => {
    const response = await fetch('http://metadata.google.internal/computeMetadata/v1/' + key,
      {headers: {'Metadata-Flavor': 'Google'}, redirect: 'error', signal: AbortSignal.timeout(5000)});
    if (!response.ok || response.headers.get('Metadata-Flavor') !== 'Google') throw Error('maintenance_host_evidence_invalid');
    return (await response.text()).trim();
  };
  const [instanceId, projectId, zone] = await Promise.all([metadata('instance/id'), metadata('project/project-id'), metadata('instance/zone')]);
  if (projectId !== config.projectId || zone.split('/').at(-1) !== config.zone ||
      !/^[1-9][0-9]{0,19}$/.test(instanceId)) throw Error('maintenance_host_evidence_invalid');
  const mountRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mapache-import-evidence-'));
  let mounted = false;
  let receipt;
  try {
    await run('mount', ['-t', 'ext4', '-o', 'ro,noload', '/dev/disk/by-id/google-' + config.diskName, mountRoot]);
    mounted = true;
    receipt = await readRetainedDiskReceipt({...config, mountRoot});
  } finally {
    if (mounted) await run('umount', [mountRoot]);
    await fs.rmdir(mountRoot);
  }
  console.log(JSON.stringify({instanceId, receipt}));
} catch (error) {
  const reason = /^(maintenance_|disk_import_|import_tree_|import_stage_|merge_)[a-z_]+$/.test(error.message)
    ? error.message : 'maintenance_receipt_unavailable';
  console.error(reason);
  process.exitCode = 1;
}
