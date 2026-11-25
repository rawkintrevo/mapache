#!/usr/bin/env node
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';

const require = createRequire(import.meta.url);
const {createComputeEngineService} = require('../functions/computeEngine.service');
const {createRuntimeDescriptor} = require('../functions/runtimeProvider.helpers');
const {tokenHash} = require('../functions/vmRuntimeControl.service');
const admin = require('../functions/node_modules/firebase-admin');

async function main() {

// Deliberately fixed synthetic identity: never accepts a user workspace ID.
const [action = 'inspect', generationText = '1', image = ''] = process.argv.slice(2);
const generation = Number(generationText);
if (!['inspect', 'start', 'pause', 'replace'].includes(action) || !Number.isSafeInteger(generation) || generation < 1) {
  throw new Error('usage: vm-crossover-fixture.mjs inspect|start|pause|replace GENERATION [PINNED_IMAGE]');
}
if (['start', 'replace'].includes(action) && !/^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/.test(image)) {
  throw new Error('start/replace requires a project-owned immutable runner digest');
}
let descriptor = createRuntimeDescriptor({
  backend: 'compute-engine', workspaceId: 'vm-proof-605', ownerUid: 'vm-proof-owner',
  region: 'us-central1', zone: 'us-central1-a', generation,
});
const service = createComputeEngineService({projectId: 'pi-agents-cloud'});
if (action === 'replace') {
  await service.pause(descriptor, {operationId: `fixture-605-replace-${generation}`});
  descriptor = createRuntimeDescriptor({...descriptor, generation: generation + 1, instanceName: null});
}
let secrets;
const sessionId = `vm-proof-605-g${descriptor.generation}`;
if (['start', 'replace'].includes(action)) {
  admin.initializeApp({projectId: 'pi-agents-cloud'});
  const db = admin.firestore();
  const workspaceRef = db.collection('vmRuntimes_v2').doc(descriptor.workspaceId);
  const sessionRef = workspaceRef.collection('sessions').doc(sessionId);
  const secretRef = db.collection('vmRuntimeCredentials_v2').doc(sessionId);
  secrets = await db.runTransaction(async (tx) => {
    const [ws, ss, cs] = await Promise.all([tx.get(workspaceRef), tx.get(sessionRef), tx.get(secretRef)]);
    if (ws.exists && (ws.data().ownerUid !== descriptor.ownerUid || ws.data().generation > descriptor.generation ||
        (ws.data().generation === descriptor.generation && ws.data().currentSessionId !== sessionId))) {
      throw new Error('fixture_registry_conflict');
    }
    if (ss.exists) {
      if (ss.data().ownerUid !== descriptor.ownerUid || !cs.exists ||
          !['reserved', 'active'].includes(ss.data().state) ||
          tokenHash(cs.data().controlToken) !== ss.data().controlTokenHash) throw new Error('fixture_session_conflict');
      return {...cs.data(), allowCreateDisk: ss.data().allowCreateDisk === true && ss.data().state === 'reserved' && !ss.data().bootId};
    }
    if (cs.exists) throw new Error('fixture_credentials_conflict');
    const credentials = {ownerUid: descriptor.ownerUid, generation: descriptor.generation,
      controlToken: randomBytes(32).toString('hex'), browserToken: randomBytes(32).toString('hex'), shutdownToken: randomBytes(32).toString('hex')};
    const previousWorkspace = ws.exists ? ws.data() : {};
    const previousSession = ss.exists ? ss.data() : (ws.exists && previousWorkspace.currentSessionId ?
      (await tx.get(workspaceRef.collection('sessions').doc(previousWorkspace.currentSessionId))).data() || {} : {});
    tx.set(secretRef, credentials);
    tx.set(workspaceRef, {
      ownerUid: descriptor.ownerUid,
      backend: 'compute-engine',
      currentSessionId: sessionId,
      generation: descriptor.generation,
      state: 'reserved',
      // This fixed workspace is the explicitly admitted lifecycle fixture.
      lifecycleEnabled: true,
      ...(Object.hasOwn(previousWorkspace, 'apiEnabled') ? {apiEnabled: previousWorkspace.apiEnabled} : {}),
      ...(typeof previousWorkspace.name === 'string' ? {name: previousWorkspace.name} : {}),
      ...(typeof previousWorkspace.runnerImage === 'string' ? {runnerImage: previousWorkspace.runnerImage} : {}),
      ...(typeof previousWorkspace.gatewayHost === 'string' ? {gatewayHost: previousWorkspace.gatewayHost} : {}),
      ...(previousWorkspace.machineConfig && typeof previousWorkspace.machineConfig === 'object' ? {machineConfig: previousWorkspace.machineConfig} : {}),
    });
    tx.set(sessionRef, {ownerUid: descriptor.ownerUid, generation: descriptor.generation, state: 'reserved',
      allowCreateDisk: !ws.exists,
      controlTokenHash: tokenHash(credentials.controlToken),
      authSelection: previousSession.authSelection || {harness: 'pi', providers: {}},
      piScopedModels: Array.isArray(previousSession.piScopedModels) ? previousSession.piScopedModels : [],
      environmentEntryIds: Array.isArray(previousSession.environmentEntryIds) ? previousSession.environmentEntryIds : [],
      ...(Number.isSafeInteger(previousSession.configVersion) ? {configVersion: previousSession.configVersion} : {}),
      runtimeProvider: descriptor});
    return {...credentials, allowCreateDisk: !ws.exists};
  });
}
const options = {
  operationId: `fixture-605-${action}-${generation}`,
  allowCreateDisk: secrets?.allowCreateDisk === true,
  runnerImage: image,
  subnetwork: 'projects/pi-agents-cloud/regions/us-central1/subnetworks/mapache-vm-v2-us-central1',
  timeoutMs: 240000,
  env: {
    MAPACHE_AGENT_UI_VERSION: 'pi-web-ui-v1',
    GCLOUD_PROJECT: 'pi-agents-cloud',
    MAPACHE_VM_CONTROL_URL: 'https://us-central1-pi-agents-cloud.cloudfunctions.net/vmRuntimeControl_v2',
    MAPACHE_VM_CONTROL_TOKEN: secrets?.controlToken || '',
    MAPACHE_PI_MODEL_CATALOG_REFRESH: 'false',
    SESSION_ID: sessionId,
    SESSION_BROWSER_TOKEN_SECRET: secrets?.browserToken || '',
    SESSION_SHUTDOWN_TOKEN: secrets?.shutdownToken || '',
    RUNNER_CAPABILITIES: JSON.stringify({terminal: true, preview: true, previewQa: false, functions: false, chrome: false}),
  },
};
await service[action === 'replace' ? 'start' : action](descriptor, options);
// Inspect output excludes startup metadata, tokens, and other credentials.
console.log(JSON.stringify(await service.inspect(descriptor), null, 2));
}

main().catch((error) => {
  // Gaxios errors can contain request headers/metadata; never serialize them.
  console.error(JSON.stringify({error: String(error.code || 'fixture_failed'), message: error.message}));
  process.exitCode = 1;
});
