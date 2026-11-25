import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {isDeepStrictEqual, promisify} from 'node:util';

const require = createRequire(import.meta.url);
const {createRuntimeDescriptor} = require('../../functions/runtimeProvider.helpers.js');
const run = promisify(execFile);
const fail = reason => { throw Error(reason); };

export function createMaintenanceEvidenceReader({compute, maintenance, readMountedReceipt, releaseAttachment}) {
  return async ({workspaceId, ownerUid, destination, prefixCapture}) => {
    const {operationId, diskName, diskId, generation, region, zone} = destination;
    const descriptor = createRuntimeDescriptor({backend: 'compute-engine', workspaceId, ownerUid, generation, region, zone});
    const check = () => compute.inspectMigrationDisk(descriptor, {operationId, maintenance});
    const before = await check();
    if (before.diskId !== diskId || before.diskName !== diskName) fail('maintenance_disk_identity_changed');
    const report = await readMountedReceipt({ownerUid, workspaceId, generation, operationId, diskName, prefixCapture, zone});
    const expected = {workspaceId, ownerUid, operationId, generation, diskName};
    if (report?.instanceId !== maintenance.instanceId ||
        Object.keys(expected).some(key => report.receipt?.destination?.[key] !== expected[key]) ||
        Object.keys(prefixCapture).some(key => report.receipt?.prefixCapture?.[key] !== prefixCapture[key])) {
      fail('maintenance_host_evidence_invalid');
    }
    if (!isDeepStrictEqual(before, await check())) fail('maintenance_disk_attachment_changed');
    await releaseAttachment({diskName, zone});
    // The coordinator independently observes detachment after receipt validation.
    return {diskId, receipt: report.receipt};
  };
}

export function createIapMaintenanceEvidenceReader({projectId, compute, maintenance}) {
  const common = zone => ['--project', projectId, '--zone', zone, '--quiet'];
  return createMaintenanceEvidenceReader({
    compute, maintenance,
    readMountedReceipt: config => new Promise((resolve, reject) => {
      const child = execFile('gcloud', ['compute', 'ssh', maintenance.instanceName, ...common(config.zone),
        '--tunnel-through-iap', '--strict-host-key-checking=yes', '--ssh-flag=-oBatchMode=yes',
        '--command=sudo -n node /opt/mapache-maintenance/scripts/vm-read-imported-disk.mjs'],
      {timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024}, (error, stdout) => {
        if (error) return reject(Error('maintenance_receipt_unavailable'));
        try { return resolve(JSON.parse(stdout)); } catch { return reject(Error('maintenance_host_evidence_invalid')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({...config, projectId}));
    }),
    releaseAttachment: async ({diskName, zone}) => {
      await run('gcloud', ['compute', 'instances', 'detach-disk', maintenance.instanceName, ...common(zone),
        '--device-name', diskName], {timeout: 120000});
    },
  });
}
