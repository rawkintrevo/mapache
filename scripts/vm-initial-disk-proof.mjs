#!/usr/bin/env node
// Deliberately separate processes for disk creation and boot. No registry,
// gateway route, credentials or real user workspace is touched by this proof.
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createComputeEngineService} = require('../functions/computeEngine.service');
const {createRuntimeDescriptor} = require('../functions/runtimeProvider.helpers');
const descriptor = createRuntimeDescriptor({backend: 'compute-engine', workspaceId: 'vm-initial-disk-proof-605',
  ownerUid: 'vm-proof-owner', region: 'us-central1', zone: 'us-central1-a', generation: 1});
const [action, image] = process.argv.slice(2);
const service = createComputeEngineService({projectId: 'pi-agents-cloud'});
async function main() {
  if (!['disk', 'boot', 'inspect', 'pause'].includes(action)) throw new Error('invalid_action');
  const options = {operationId: 'initial-disk-proof-605', allowCreateDisk: true, timeoutMs: 240000,
    subnetwork: 'projects/pi-agents-cloud/regions/us-central1/subnetworks/mapache-vm-v2-us-central1'};
  if (action === 'disk') await service.ensureDataDisk(descriptor, options);
  if (action === 'boot') {
    if (!/^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/.test(image || '')) throw new Error('pinned_image_required');
    const before = await service.inspect(descriptor);
    if (!before.disk || before.instance) throw new Error('separate_disk_stage_required');
    // Only the host mount/marker is tested. No usable runner credentials, lease
    // admission or network route are supplied to this isolated VM.
    await service.start(descriptor, {...options, runnerImage: image});
  }
  if (action === 'pause') await service.pause(descriptor, options);
  console.log(JSON.stringify(await service.inspect(descriptor), null, 2));
}
main().catch(error => { console.error(JSON.stringify({error: error.code || 'initial_disk_proof_failed'})); process.exitCode = 1; });
