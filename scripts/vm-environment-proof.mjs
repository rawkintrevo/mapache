#!/usr/bin/env node
// Synthetic fixture only. This deliberately uses a non-secret marker value.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
const [action] = process.argv.slice(2);
const projectId = 'pi-agents-cloud';
const workspaceId = 'vm-proof-605';
const ownerUid = 'vm-proof-owner';
const entryId = 'vm605-environment-proof';
const name = 'VM605_ENV_PROOF';
const value = 'synthetic-environment-replacement-proof';

async function main() {
  assert.ok(['seed', 'verify', 'cleanup'].includes(action));
  admin.initializeApp({projectId});
  const db = admin.firestore();
  const wr = db.doc(`vmRuntimes_v2/${workspaceId}`);
  const er = db.doc(`users/${ownerUid}/private/environmentKeys/entries/${entryId}`);
  const result = await db.runTransaction(async tx => {
    const w = (await tx.get(wr)).data();
    assert.equal(w?.ownerUid, ownerUid);
    assert.equal(w?.backend, 'compute-engine');
    assert.equal(w?.state, 'active');
    assert.ok(!w.activeOperationId);
    assert.equal(w.lifecycleReadyGeneration, w.generation);
    const sr = wr.collection('sessions').doc(w.currentSessionId);
    const [s, e] = await Promise.all([tx.get(sr), tx.get(er)]);
    const session = s.data();
    assert.equal(session?.ownerUid, ownerUid);
    assert.equal(session?.generation, w.generation);
    if (action === 'seed') {
      assert.ok(!e.exists, 'proof already seeded');
      assert.deepEqual(session.environmentEntryIds || [], [], 'preserve existing selections');
      const previousMachineConfig = w.machineConfig && typeof w.machineConfig === 'object' ? {
        ...w.machineConfig,
        ...(w.machineConfig.desired ? {desired: {...w.machineConfig.desired}} : {}),
      } : null;
      tx.create(er, {ownerUid, name, value, proofWorkspaceId: workspaceId, seedGeneration: w.generation, previousMachineConfig});
      tx.update(sr, {environmentEntryIds: [entryId]});
      if (previousMachineConfig) {
        tx.update(wr, {machineConfig: {...previousMachineConfig,
          desiredVersion: previousMachineConfig.desiredVersion + 1,
          desired: {...previousMachineConfig.desired, environmentEntryIds: [entryId]},
          state: 'pending-restart'}});
      }
    } else {
      const entry = e.data();
      assert.equal(entry?.proofWorkspaceId, workspaceId);
      assert.equal(entry?.ownerUid, ownerUid);
      assert.equal(entry?.value, value);
      assert.deepEqual(session.environmentEntryIds, [entryId]);
      if (action === 'verify') {
        assert.equal(w.generation, entry.seedGeneration + 1);
        if (w.machineConfig) {
          assert.deepEqual(w.machineConfig.desired.environmentEntryIds, [entryId]);
          assert.equal(w.machineConfig.appliedVersion, w.machineConfig.desiredVersion);
          assert.equal(w.machineConfig.state, 'applied');
        }
        assert.ok(!JSON.stringify(w).includes(value));
        assert.ok(!JSON.stringify(session).includes(value));
      } else {
        tx.update(sr, {environmentEntryIds: []});
        if (entry.previousMachineConfig) tx.update(wr, {machineConfig: entry.previousMachineConfig});
        else if (w.machineConfig) tx.update(wr, {machineConfig: admin.firestore.FieldValue.delete()});
        tx.delete(er);
      }
    }
    return {generation: w.generation, instanceName: session.runtimeProvider.instanceName};
  });
  if (action === 'verify') {
    assert.match(result.instanceName, /^mapache-vm-[a-f0-9]+$/);
    // Fixed command, no credentials or remote data interpolated into shell code.
    execFileSync('gcloud', ['compute', 'ssh', result.instanceName, '--zone', 'us-central1-a',
      '--project', projectId, '--tunnel-through-iap', '--quiet', '--command',
      'sudo docker exec mapache-runner node -e \'require("node:assert/strict").equal(process.env.VM605_ENV_PROOF,"synthetic-environment-replacement-proof")\''],
    {stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000});
  }
  const evidence = {ok: true, action, workspaceId, generation: result.generation};
  await mkdir('artifacts/qa/vm-environment', {recursive: true});
  await writeFile(`artifacts/qa/vm-environment/${action}.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
main().catch(() => { console.error('VM environment proof failed; inspect fixture state before retrying.'); process.exitCode = 1; });
