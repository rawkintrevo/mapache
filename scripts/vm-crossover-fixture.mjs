#!/usr/bin/env node
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';

const require = createRequire(import.meta.url);
const {createComputeEngineService} = require('../functions/computeEngine.service');
const {createRuntimeDescriptor} = require('../functions/runtimeProvider.helpers');

// Deliberately fixed synthetic identity: never accepts a user workspace ID.
const [action = 'inspect', generationText = '1', image = ''] = process.argv.slice(2);
const generation = Number(generationText);
if (!['inspect', 'start', 'pause', 'replace'].includes(action) || !Number.isSafeInteger(generation) || generation < 1) {
  throw new Error('usage: vm-crossover-fixture.mjs inspect|start|pause|replace GENERATION [PINNED_IMAGE]');
}
if (['start', 'replace'].includes(action) && !/^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/.test(image)) {
  throw new Error('start/replace requires a project-owned immutable runner digest');
}
const descriptor = createRuntimeDescriptor({
  backend: 'compute-engine', workspaceId: 'vm-proof-605', ownerUid: 'vm-proof-owner',
  region: 'us-central1', zone: 'us-central1-a', generation,
});
const service = createComputeEngineService({projectId: 'pi-agents-cloud'});
const options = {
  operationId: `fixture-605-${action}-${generation}`,
  runnerImage: image,
  subnetwork: 'projects/pi-agents-cloud/regions/us-central1/subnetworks/mapache-vm-v2-us-central1',
  timeoutMs: 240000,
  env: {
    MAPACHE_AGENT_UI_VERSION: 'pi-web-ui-v1',
    MAPACHE_STARTUP_SMOKE: '1',
    MAPACHE_PI_MODEL_CATALOG_REFRESH: 'false',
    SESSION_ID: 'vm-proof-605',
    SESSION_BROWSER_TOKEN_SECRET: randomBytes(32).toString('hex'),
    RUNNER_CAPABILITIES: JSON.stringify({terminal: true, preview: true, previewQa: false, functions: false, chrome: false}),
  },
};
await service[action](descriptor, options);
// Inspect output excludes startup metadata, tokens, and other credentials.
const observed = action === 'replace' ? createRuntimeDescriptor({...descriptor, generation: generation + 1, instanceName: null}) : descriptor;
console.log(JSON.stringify(await service.inspect(observed), null, 2));
