#!/usr/bin/env node
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
const {tokenHash} = require('../functions/vmRuntimeControl.service');
admin.initializeApp({projectId: 'pi-agents-cloud'});
const db = admin.firestore();
const id = `vm-control-probe-${Date.now()}-${randomBytes(4).toString('hex')}`;
const token = randomBytes(32).toString('hex');
const workspace = db.collection('vmRuntimes_v2').doc(id);
const session = workspace.collection('sessions').doc('probe');

async function main() {
  const batch = db.batch();
  batch.create(workspace, {ownerUid: id, backend: 'compute-engine', generation: 1, currentSessionId: 'probe', state: 'reserved'});
  batch.create(session, {ownerUid: id, generation: 1, state: 'reserved', controlTokenHash: tokenHash(token)});
  await batch.commit();
  try {
    const call = async (action, bootId = 'boot-a', extra = {}, credential = token) => {
      const response = await fetch('https://us-central1-pi-agents-cloud.cloudfunctions.net/vmRuntimeControl_v2', {
        method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${credential}`},
        body: JSON.stringify({workspaceId: id, sessionId: 'probe', generation: 1, bootId, action, ...extra}),
        signal: AbortSignal.timeout(30000),
      });
      return {status: response.status, data: await response.json()};
    };
    assert.equal((await call('lease.acquire', 'boot-a', {}, 'wrong')).status, 404);
    const competing = await Promise.all([call('lease.acquire', 'boot-a'), call('lease.acquire', 'boot-b')]);
    assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
    const boot = competing[0].status === 200 ? 'boot-a' : 'boot-b';
    assert.equal((await call('lease.renew', boot)).status, 200);
    assert.equal((await call('models.get', boot, {generation: 2})).status, 409);
    assert.equal((await call('activity', boot, {payload: {state: 'reserved'}})).status, 400);
    assert.equal((await call('models.set', boot, {payload: {models: ['fixture/model']}})).status, 200);
    assert.deepEqual((await call('models.get', boot)).data.models, ['fixture/model']);
    const expire = db.batch();
    expire.update(workspace, {leaseExpiresAt: 0});
    expire.update(session, {leaseExpiresAt: 0});
    await expire.commit();
    assert.equal((await call('lease.renew', boot)).status, 409);
    console.log(JSON.stringify({ok: true, concurrentBootFencing: true, tokenRejection: true,
      staleGenerationRejection: true, arbitraryWriteRejection: true, modelRoundTrip: true, expiryRejection: true}));
  } finally {
    const cleanup = db.batch();
    cleanup.delete(session);
    cleanup.delete(workspace);
    await cleanup.commit();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
