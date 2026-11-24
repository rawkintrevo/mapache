import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';

const require = createRequire(import.meta.url);
const {createComputeEngineService} = require('../functions/computeEngine.service');
const {createRuntimeDescriptor} = require('../functions/runtimeProvider.helpers');
const {tokenHash} = require('../functions/vmRuntimeControl.service');
const admin = require('../functions/node_modules/firebase-admin');
const projectId = 'pi-agents-cloud';
const workspaceId = 'vm-import-proof-605';
const ownerUid = 'vm-proof-owner';
const generation = 1;
const operationId = 'retained-import-proof-605';
const sessionId = workspaceId + '-g1';
const descriptor = createRuntimeDescriptor({backend: 'compute-engine', workspaceId, ownerUid, generation,
  region: 'us-central1', zone: 'us-central1-a'});

async function main() {
  const [action, runnerImage] = process.argv.slice(2);
  if (!['start', 'cleanup'].includes(action)) throw Error('invalid_action');
  if (action === 'start' && !/^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/.test(runnerImage || '')) {
    throw Error('pinned_runner_required');
  }
  const compute = createComputeEngineService({projectId});
  const observed = await compute.inspect(descriptor);
  const options = {operationId, requireCreationMatch: true, timeoutMs: 240000};
  if (!observed.disk) throw Error('import_disk_missing');
  await compute.ensureDataDisk(descriptor, options);
  if (action === 'start' && !observed.instance && observed.disk.users.length) throw Error('import_disk_attached');
  admin.initializeApp({projectId});
  const db = admin.firestore();
  const workspaceRef = db.collection('vmRuntimes_v2').doc(workspaceId);
  const sessionRef = workspaceRef.collection('sessions').doc(sessionId);
  const credentialRef = db.collection('vmRuntimeCredentials_v2').doc(sessionId);
  async function transaction(cleanup) {
    return db.runTransaction(async tx => {
      const [workspace, session, credential] = await tx.getAll(workspaceRef, sessionRef, credentialRef);
      const snapshots = [workspace, session, credential];
      const identity = {ownerUid, generation, importProof: operationId};
      if (snapshots.some(snapshot => snapshot.exists)) {
        if (!snapshots.every(snapshot => snapshot.exists && Object.entries(identity)
          .every(([key, value]) => snapshot.get(key) === value)) ||
          workspace.get('currentSessionId') !== sessionId ||
          tokenHash(credential.get('controlToken')) !== session.get('controlTokenHash')) {
          throw Error('fixture_registry_conflict');
        }
        if (cleanup) {
          for (const snapshot of snapshots) tx.delete(snapshot.ref);
          return;
        }
        return credential.data();
      }
      if (cleanup) return;
      const token = () => randomBytes(32).toString('hex');
      const credentials = {...identity, controlToken: token(), browserToken: token(), shutdownToken: token()};
      tx.create(workspaceRef, {...identity, backend: 'compute-engine', state: 'reserved', currentSessionId: sessionId});
      tx.create(sessionRef, {...identity, state: 'reserved', runtimeProvider: descriptor,
        controlTokenHash: tokenHash(credentials.controlToken), authSelection: {harness: 'pi', providers: {}}});
      tx.create(credentialRef, credentials);
      return credentials;
    });
  }
  if (action === 'cleanup') {
    await compute.pause(descriptor, options);
    await transaction(true);
    console.log(JSON.stringify({instanceDeleted: true, diskDetached: true, registryDeleted: true}));
    return;
  }
  const credentials = await transaction(false);
  await compute.start(descriptor, {...options, runnerImage,
    subnetwork: 'projects/pi-agents-cloud/regions/us-central1/subnetworks/mapache-vm-v2-us-central1',
    env: {
      MAPACHE_AGENT_UI_VERSION: 'pi-web-ui-v1',
      GCLOUD_PROJECT: projectId,
      MAPACHE_VM_CONTROL_URL: 'https://us-central1-pi-agents-cloud.cloudfunctions.net/vmRuntimeControl_v2',
      MAPACHE_VM_CONTROL_TOKEN: credentials.controlToken,
      MAPACHE_PI_MODEL_CATALOG_REFRESH: 'false',
      SESSION_ID: sessionId,
      SESSION_BROWSER_TOKEN_SECRET: credentials.browserToken,
      SESSION_SHUTDOWN_TOKEN: credentials.shutdownToken,
      RUNNER_CAPABILITIES: JSON.stringify({terminal: true, preview: true, previewQa: false, functions: false, chrome: false}),
    },
  });
  console.log(JSON.stringify({instance: descriptor.instanceName, sessionId}));
}

main().catch(error => {
  const reason = [error.code, error.message].find(value => typeof value === 'string' && /^[a-z_]+$/.test(value));
  console.error(JSON.stringify({error: reason || 'fixture_operation_failed'}));
  process.exitCode = 1;
});
