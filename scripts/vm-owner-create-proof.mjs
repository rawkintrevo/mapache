// Called by the owner API harness after it establishes temporary Firebase auth.
// The fixed fixture uses a separate gateway tag; never takes the main fixture's route.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createComputeEngineService} = require('../functions/computeEngine.service');

export async function proveOwnerCreation({db, call, outsiderToken, nonce}) {
  const workspaceId = 'vm-owner-create-605';
  const host = 'create-proof---mapache-vm-gateway-v2-pxyyg7zwda-uc.a.run.app';
  const ar = db.doc(`vmCreationAdmissions_v2/${workspaceId}`);
  const wr = db.doc(`vmRuntimes_v2/${workspaceId}`);
  const source = (await db.doc('vmRuntimes_v2/vm-proof-605').get()).data();
  assert.equal(source?.ownerUid, 'vm-proof-owner');
  const input = {name: 'VM creation proof', requestId: `create-${nonce}`};
  assert.equal((await call(`${workspaceId}/create`, 'POST', input)).status, 404);
  await db.runTransaction(async tx => {
    const [a, w, r] = await Promise.all([tx.get(ar), tx.get(wr), tx.get(db.doc(`vmGatewayRoutes_v2/${host}`))]);
    assert.ok(!a.exists && !w.exists && !r.exists, 'creation fixture must be absent before this proof');
    tx.set(ar, {enabled: true, ownerUid: 'vm-proof-owner', runnerImage: source.runnerImage, gatewayHost: host, proofRunId: nonce});
  });
  assert.equal((await call(`${workspaceId}/create`, 'POST', input, outsiderToken)).status, 404);
  assert.equal((await call(`${workspaceId}/create`, 'POST', {...input, runnerImage: 'caller-image'})).status, 400);
  const first = await call(`${workspaceId}/create`, 'POST', input);
  const second = await call(`${workspaceId}/create`, 'POST', input);
  assert.equal(first.status, 202); assert.equal(second.status, 202);
  assert.equal(first.body.operationId, second.body.operationId);
  assert.equal((await call(`${workspaceId}/create`, 'POST', {...input, requestId: `other-${nonce}`})).status, 409);
  async function wait(id) {
    let phase;
    for (let i = 0; i < 150; i++) {
      const response = await call(`${workspaceId}/operations/${id}`);
      assert.equal(response.status, 200);
      if (phase !== response.body.phase) console.log(JSON.stringify({workspaceId, operationId: id, phase: response.body.phase}));
      phase = response.body.phase;
      if (response.body.status === 'succeeded') return response.body;
      assert.equal(response.body.status, 'pending');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error('creation_proof_operation_still_pending');
  }
  await wait(first.body.operationId);
  assert.equal((await call(workspaceId)).body.workspace.ready, true);
  const access = await call(`${workspaceId}/access`, 'POST', {expectedGeneration: 1});
  assert.equal(access.status, 200);
  const url = new URL(access.body.agentUrl); assert.equal(url.hostname, host);
  const page = await fetch(url, {redirect: 'manual', signal: AbortSignal.timeout(30000)});
  assert.equal(page.status, 303);
  const cookie = page.headers.get('set-cookie')?.match(/(?:^|,\s*)mapache_access=([^;]+)/)?.[1];
  assert.ok(cookie); await page.body?.cancel();
  const redirected = await fetch(`https://${host}/agent/`, {headers: {cookie: `mapache_access=${cookie}`}, signal: AbortSignal.timeout(30000)});
  assert.equal(redirected.status, 200); await redirected.body?.cancel();
  const paused = await call(`${workspaceId}/pause`, 'POST', {expectedGeneration: 1, requestId: `pause-${nonce}`});
  assert.equal(paused.status, 202); await wait(paused.body.operationId);
  const ws = (await wr.get()).data();
  const session = (await wr.collection('sessions').doc(ws.currentSessionId).get()).data();
  const compute = createComputeEngineService({projectId: 'pi-agents-cloud'});
  const observed = await compute.inspect(session.runtimeProvider);
  assert.equal(observed.instance, null); assert.deepEqual(observed.disk.users, []);
  execFileSync('gcloud', ['compute', 'disks', 'delete', observed.disk.name, '--zone', 'us-central1-a', '--project', 'pi-agents-cloud', '--quiet'], {stdio: 'pipe'});
  assert.equal((await compute.inspect(session.runtimeProvider)).disk, null);
  // No pending worker remains; delete only records belonging to this proof.
  assert.equal((await ar.get()).data().proofRunId, nonce);
  await db.doc(`vmGatewayRoutes_v2/${host}`).delete();
  await db.doc(`vmRuntimeCredentials_v2/${ws.currentSessionId}`).delete();
  await db.recursiveDelete(wr); await ar.delete();
  return {workspaceId, createOperationId: first.body.operationId, pauseOperationId: paused.body.operationId,
    ownerCreation: true, duplicateSuppression: true, originIsolation: true, agentAccess: true, resourcesRemoved: true};
}
