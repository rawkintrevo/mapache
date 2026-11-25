#!/usr/bin/env node
// Private operator API QA, fixed synthetic identity; never emits bearer tokens.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
const [action = 'status', value = '', requestId = ''] = process.argv.slice(2);

async function main() {
  const project = 'pi-agents-cloud';
  const workspaceId = 'vm-proof-605';
  const ownerUid = 'vm-proof-owner';
  if (action === 'admit') {
    const generation = Number(value);
    assert.ok(Number.isSafeInteger(generation) && generation > 0);
    const gateway = JSON.parse(execFileSync('gcloud', ['run', 'services', 'describe', 'mapache-vm-gateway-v2',
      '--region', 'us-central1', '--project', project, '--format=json'], {encoding: 'utf8'}));
    const host = new URL(gateway.status.url).hostname;
    admin.initializeApp({projectId: project}); const db = admin.firestore();
    const ref = db.doc(`vmRuntimes_v2/${workspaceId}`);
    await db.runTransaction(async tx => {
      const [w, r] = await Promise.all([tx.get(ref), tx.get(db.doc(`vmGatewayRoutes_v2/${host}`))]);
      assert.equal(w.data()?.ownerUid, ownerUid);
      assert.equal(w.data()?.generation, generation);
      assert.equal(w.data()?.state, 'active');
      assert.ok(!w.data()?.activeOperationId);
      assert.equal(r.data()?.workspaceId, workspaceId);
      assert.equal(r.data()?.ownerUid, ownerUid);
      assert.equal(r.data()?.generation, generation);
      const runnerImage = requestId || w.data()?.runnerImage;
      assert.match(runnerImage || '', /^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/,
        'admit requires a stored image or an explicit pinned image argument');
      tx.update(ref, {lifecycleEnabled: true, gatewayHost: host,
        runnerImage});
    });
    console.log(JSON.stringify({ok: true, action, workspaceId, generation})); return;
  }
  assert.ok(['pause', 'start', 'replace', 'status', 'wait'].includes(action));
  const token = execFileSync('gcloud', ['auth', 'print-identity-token', '--project', project], {encoding: 'utf8'}).trim();
  async function call(body) {
    const response = await fetch('https://us-central1-pi-agents-cloud.cloudfunctions.net/vmLifecycle_v2', {
      method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`vm_lifecycle_request:${response.status}:${data.error}`);
    return data;
  }
  if (action === 'status' || action === 'wait') {
    let previous;
    for (let attempt = 0; attempt < (action === 'wait' ? 120 : 1); attempt++) {
      const status = await call({action: 'status', operationId: value});
      assert.equal(status.workspaceId, workspaceId);
      if (JSON.stringify(status) !== previous) console.log(JSON.stringify(status));
      previous = JSON.stringify(status);
      if (status.status !== 'pending') {
        await mkdir('artifacts/qa/vm-lifecycle', {recursive: true});
        await writeFile(`artifacts/qa/vm-lifecycle/${value}.json`, JSON.stringify(status, null, 2));
        return;
      }
      if (action === 'wait') await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (action === 'wait') throw new Error('fixture_wait_deadline_operation_still_pending');
    return;
  }
  assert.ok(requestId && Number.isSafeInteger(Number(value)));
  const body = {workspaceId, ownerUid, requestId, action, expectedGeneration: Number(value)};
  // An identical retry must not create a second operation.
  const first = await call(body); const retry = await call(body);
  assert.equal(first.operationId, retry.operationId);
  console.log(JSON.stringify({...first, duplicateRequestIdempotent: true}));
}
main().catch(error => { console.error(JSON.stringify({error: error.message})); process.exitCode = 1; });
