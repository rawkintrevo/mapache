#!/usr/bin/env node
// Live Firebase-owner API proof for the fixed synthetic machine only.
// Tokens remain in memory. Temporary allowlist entries/admission are restored.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {proveOwnerCreation} from './vm-owner-create-proof.mjs';
import {liveShellProof} from './vm-live-shell-proof.mjs';
const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
const {isFirebaseTokenAllowed, parseAppAllowList} = require('../functions/appAllowList.helpers');
const mode = process.argv[2] || 'probe';
const project = 'pi-agents-cloud';
const base = 'https://us-central1-pi-agents-cloud.cloudfunctions.net';
const uids = ['vm-proof-owner', 'vm-proof-outsider'];

async function main() {
  assert.ok(['probe', 'cycle', 'create', 'shell', 'configuration'].includes(mode));
  admin.initializeApp({projectId: project});
  const db = admin.firestore(); const auth = admin.auth();
  const preexistingUsers = new Set();
  const preexistingProfiles = new Set();
  for (const uid of uids) {
    try {
      const user = await auth.getUser(uid);
      assert.equal(user.customClaims?.vmFixture605, true, 'synthetic UID belongs to an unrelated account');
      preexistingUsers.add(uid);
    } catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
    if ((await db.doc(`users/${uid}`).get()).exists) preexistingProfiles.add(uid);
  }
  const source = await readFile('src/services/auth.js', 'utf8');
  const apiKey = source.match(/apiKey:\s*"([^"]+)"/)?.[1];
  assert.ok(apiKey, 'public Firebase client configuration missing');
  const operatorToken = execFileSync('gcloud', ['auth', 'print-identity-token', '--project', project], {encoding: 'utf8'}).trim();
  const wr = db.doc('vmRuntimes_v2/vm-proof-605'); const accessRef = db.doc('appConfig/access');
  const nonce = randomUUID();
  const setup = await db.runTransaction(async tx => {
    const [w, a] = await Promise.all([tx.get(wr), tx.get(accessRef)]);
    const ws = w.data(); const access = a.data() || {};
    assert.equal(ws?.ownerUid, uids[0]); assert.equal(ws?.state, 'active');
    assert.ok(!ws.activeOperationId && !ws.apiQaRunId);
    const added = uids.filter(uid => !isFirebaseTokenAllowed({uid}, access));
    const allowed = [...parseAppAllowList(access.allowedUids).map(entry => entry.value), ...added];
    if (added.length) tx.update(accessRef, {allowedUids: allowed});
    tx.update(wr, {apiEnabled: true, apiQaRunId: nonce});
    if (mode === 'shell') tx.update(wr, {metricsOrigins: [...new Set([...(ws.metricsOrigins || []), 'http://127.0.0.1:5174'])]});
    return {apiEnabled: ws.apiEnabled === true, generation: ws.generation, added, allowed, previousAllowed: access.allowedUids, metricsOrigins: ws.metricsOrigins};
  });
  const result = {ok: false, mode, fromGeneration: setup.generation};
  try {
    const tokens = {};
    let ownerCustomToken;
    for (const [index, identity] of ['owner', 'outsider'].entries()) {
      const signed = await fetch(`${base}/vmFixtureAuth_v2`, {method: 'POST',
        headers: {authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json'},
        body: JSON.stringify({identity}), signal: AbortSignal.timeout(30000)});
      assert.equal(signed.status, 200, 'private fixture signer failed');
      const custom = await signed.json(); assert.equal(custom.uid, uids[index]);
      if (identity === 'owner') ownerCustomToken = custom.token;
      const login = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token: custom.token, returnSecureToken: true}),
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(login.status, 200, 'Firebase fixture login failed');
      const data = await login.json();
      const verified = await auth.verifyIdToken(data.idToken);
      assert.equal(verified.uid, uids[index]); tokens[identity] = data.idToken;
    }
    async function call(path, method = 'GET', body, token = tokens.owner) {
      const response = await fetch(`${base}/vmApi_v2/workspaces/${path}`, {method,
        headers: {...(token ? {authorization: `Bearer ${token}`} : {}), 'content-type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(30000)});
      return {status: response.status, body: await response.json()};
    }
    assert.equal((await call('vm-proof-605', 'GET', undefined, '')).status, 401);
    assert.equal((await call('', 'GET', undefined, '')).status, 401);
    const listed = await call('?limit=1');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.workspaces.some(workspace => workspace.id === 'vm-proof-605'));
    assert.equal((await call('', 'GET', undefined, tokens.outsider)).body.workspaces.length, 0);
    assert.equal((await call('?ownerUid=vm-proof-outsider')).status, 400);
    const currentSessions = await call('vm-proof-605/sessions');
    assert.equal(currentSessions.status, 200);
    assert.equal(currentSessions.body.sessions.length, 1);
    assert.equal(currentSessions.body.sessions[0].id, currentSessions.body.workspace.canonicalSessionId);
    assert.equal(currentSessions.body.sessions[0].generation, setup.generation);
    assert.equal(currentSessions.body.sessions[0].status, 'running');
    assert.equal((await call('vm-proof-605/sessions', 'GET', undefined, tokens.outsider)).status, 404);
    for (const field of ['controlToken', 'browserToken', 'shutdownToken', 'privateAddress', 'runnerImage']) {
      assert.ok(!JSON.stringify([listed.body, currentSessions.body]).includes(`"${field}"`));
    }
    result.ownerDiscovery = true; result.canonicalSessionProjection = true;
    assert.equal((await call('vm-proof-605', 'GET', undefined, 'invalid-token')).status, 401);
    assert.equal((await call('vm-proof-605', 'GET', undefined, tokens.outsider)).status, 404);
    assert.equal((await call('vm-proof-605/pause', 'POST', {expectedGeneration: setup.generation, requestId: nonce}, tokens.outsider)).status, 404);
    assert.equal((await call('vm-proof-605/replace', 'POST', {expectedGeneration: setup.generation, requestId: nonce, ownerUid: uids[1]})).status, 400);
    assert.equal((await call('vm-proof-605/access', 'POST', {expectedGeneration: setup.generation - 1})).status, 409);
    let generation = setup.generation;
    if (mode === 'shell') result.shell = await liveShellProof({customToken: ownerCustomToken});
    if (mode === 'create') result.creation = await proveOwnerCreation({db, call, outsiderToken: tokens.outsider, nonce});
    if (mode === 'cycle' || mode === 'configuration') {
      async function lifecycle(action) {
        const request = {expectedGeneration: generation, requestId: `${action}-${nonce}`};
        const first = await call(`vm-proof-605/${action}`, 'POST', request);
        const second = await call(`vm-proof-605/${action}`, 'POST', request);
        assert.equal(first.status, 202); assert.equal(second.status, 202);
        assert.equal(first.body.operationId, second.body.operationId);
        const id = first.body.operationId;
        assert.equal((await call(`vm-proof-605/operations/${id}`, 'GET', undefined, tokens.outsider)).status, 404);
        let lastPhase;
        for (let attempt = 0; attempt < 120; attempt++) {
          const current = await call(`vm-proof-605/operations/${id}`);
          assert.equal(current.status, 200);
          if (lastPhase !== current.body.phase) console.log(JSON.stringify({phase: current.body.phase, action, operationId: id}));
          lastPhase = current.body.phase;
          if (current.body.status === 'succeeded') return current.body;
          assert.equal(current.body.status, 'pending');
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        throw new Error(`owner_api_${action}_still_pending`);
      }
      const paused = await lifecycle('pause');
      assert.equal((await call('vm-proof-605')).body.workspace.state, 'stopped');
      assert.equal((await call('vm-proof-605/access', 'POST', {expectedGeneration: generation})).status, 409);
      let savedConfiguration;
      if (mode === 'configuration') {
        const before = await call('vm-proof-605/configuration');
        assert.equal(before.status, 200);
        // Never erase an operator's independently configured fixture selection.
        assert.deepEqual(before.body.desired, {authSelection: {harness: 'pi', providers: {}}, environmentEntryIds: [], resources: null, diskSizeGb: null, description: '', idleStopMinutes: null});
        assert.equal((await call('vm-proof-605/configuration', 'GET', undefined, tokens.outsider)).status, 404);
        const patch = {expectedGeneration: generation, expectedVersion: before.body.desiredVersion,
          authSelection: {harness: 'pi', providers: {}}, environmentEntryIds: []};
        const saved = await call('vm-proof-605/configuration', 'PATCH', patch);
        assert.equal(saved.status, 200);
        savedConfiguration = saved.body;
        assert.equal(saved.body.desiredVersion, before.body.desiredVersion + 1);
        assert.equal(saved.body.appliedVersion, before.body.appliedVersion);
        assert.equal(saved.body.state, 'pending-restart');
        assert.equal(saved.body.restartRequired, true);
        assert.equal((await call('vm-proof-605/configuration', 'PATCH', patch)).status, 409);
        const stopped = (await call('vm-proof-605')).body.workspace;
        assert.equal(stopped.state, 'stopped');
        assert.equal(stopped.activeOperationId, null);
        assert.equal(stopped.generation, generation);
      }
      const started = await lifecycle('start'); generation = started.generation;
      result.pauseOperationId = paused.operationId; result.startOperationId = started.operationId;
      if (mode === 'configuration') {
        const applied = await call('vm-proof-605/configuration');
        assert.equal(applied.status, 200);
        assert.equal(applied.body.desiredVersion, savedConfiguration.desiredVersion);
        assert.equal(applied.body.appliedVersion, savedConfiguration.desiredVersion);
        assert.equal(applied.body.state, 'applied');
        assert.equal(applied.body.restartRequired, false);
        result.configuration = {savedWhileStopped: true, staleSaveRejected: true,
          crossOwnerDenied: true, appliedAfterStart: true, appliedVersion: applied.body.appliedVersion};
      }
    }
    const status = await call('vm-proof-605');
    assert.equal(status.status, 200); assert.equal(status.body.workspace.ready, true);
    const access = await call('vm-proof-605/access', 'POST', {expectedGeneration: generation});
    assert.equal(access.status, 200); assert.equal(access.body.generation, generation);
    for (const key of ['agentUrl', 'terminalUrl', 'previewUrl']) {
      const url = new URL(access.body[key]);
      assert.equal(url.protocol, 'https:'); assert.ok(url.hostname.endsWith('.a.run.app'));
    }
    for (const key of ['agentUrl', 'terminalUrl']) {
      let page = await fetch(access.body[key], {signal: AbortSignal.timeout(30000), redirect: 'manual'});
      if (page.status === 303) {
        const cookieValue = page.headers.get('set-cookie')?.match(/(?:^|,\s*)mapache_access=([^;]+)/)?.[1];
        assert.ok(cookieValue, 'runner bootstrap did not set its signed cookie');
        const cookie = `mapache_access=${cookieValue}`;
        const location = new URL(page.headers.get('location'), access.body[key]);
        assert.ok(location.origin === new URL(access.body[key]).origin && !location.searchParams.has('mapache_access'), 'unsafe bootstrap redirect');
        await page.body?.cancel();
        page = await fetch(location, {headers: {cookie}, signal: AbortSignal.timeout(30000), redirect: 'manual'});
      }
      assert.equal(page.status, 200, `${key} did not reach the runner`); await page.body?.cancel();
    }
    const gatewayToken = new URL(access.body.agentUrl).searchParams.get('mapache_access');
    assert.equal((await call('vm-proof-605', 'GET', undefined, gatewayToken)).status, 401);
    Object.assign(result, {ok: true, generation, firebaseOwnerAuthorized: true, crossOwnerDenied: true,
      staleGenerationDenied: true, browserCredentialNotApiCredential: true, ownerAccessUrls: true});
  } finally {
    await db.runTransaction(async tx => {
      const [w, a] = await Promise.all([tx.get(wr), tx.get(accessRef)]);
      if (w.data()?.ownerUid === uids[0] && w.data()?.apiQaRunId === nonce) tx.update(wr, {apiEnabled: setup.apiEnabled, apiQaRunId: admin.firestore.FieldValue.delete()});
      if (mode === 'shell' && w.data()?.apiQaRunId === nonce) tx.update(wr, {metricsOrigins: setup.metricsOrigins ?? admin.firestore.FieldValue.delete()});
      if (setup.added.length) {
        const current = a.data()?.allowedUids;
        const restored = JSON.stringify(current) === JSON.stringify(setup.allowed) ?
          setup.previousAllowed ?? admin.firestore.FieldValue.delete() :
          parseAppAllowList(current).map(entry => entry.value).filter(uid => !setup.added.includes(uid));
        tx.update(accessRef, {allowedUids: restored});
      }
    });
    for (const uid of uids) {
      if (!preexistingUsers.has(uid)) {
        try { const user = await auth.getUser(uid); if (user.customClaims?.vmFixture605 === true) await auth.deleteUser(uid); }
        catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
      }
      if (!preexistingProfiles.has(uid)) await db.doc(`users/${uid}`).delete();
    }
  }
  await mkdir('artifacts/qa/vm-owner-api', {recursive: true});
  await writeFile(`artifacts/qa/vm-owner-api/${mode}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({...result, temporaryAuthStateRestored: true}));
}
main().catch(error => {
  console.error(JSON.stringify({error: error.code || 'owner_api_proof_failed',
    message: error.code === 'ERR_ASSERTION' ? error.message : 'See the current proof phase and server status'}));
  process.exitCode = 1;
});
