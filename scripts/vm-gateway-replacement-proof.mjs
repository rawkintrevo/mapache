#!/usr/bin/env node
// Destructive only to the fixed synthetic fixture's disposable compute.
// Retains its data disk and never prints tokens or subprocess error objects.
import {createRequire} from 'node:module';
import {spawn, execFileSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
const {WebSocket} = require('../vm-gateway/node_modules/ws');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const generation = Number(process.argv[2]);
  const image = process.argv[3];
  assert.ok(Number.isSafeInteger(generation) && generation > 0);
  assert.match(image || '', /^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/);
  const run = JSON.parse(execFileSync('gcloud', ['run', 'services', 'describe', 'mapache-vm-gateway-v2',
    '--region', 'us-central1', '--project', 'pi-agents-cloud', '--format=json'], {encoding: 'utf8'}));
  const origin = new URL(run.status.url);
  assert.equal(origin.protocol, 'https:');
  assert.ok(origin.hostname.endsWith('.a.run.app'));
  admin.initializeApp({projectId: 'pi-agents-cloud'});
  const db = admin.firestore();
  const wsRef = db.doc('vmRuntimes_v2/vm-proof-605');
  const routeRef = db.doc(`vmGatewayRoutes_v2/${origin.hostname}`);
  const ws = (await wsRef.get()).data();
  assert.equal(ws.ownerUid, 'vm-proof-owner');
  assert.equal(ws.generation, generation);
  assert.equal(ws.state, 'active');
  const sessionId = `vm-proof-605-g${generation}`;
  assert.equal(ws.currentSessionId, sessionId);
  const credentials = (await db.doc(`vmRuntimeCredentials_v2/${sessionId}`).get()).data();
  assert.equal(credentials.ownerUid, 'vm-proof-owner');
  assert.equal(credentials.generation, generation);
  // Long enough that rejection after replacement cannot be explained by expiry.
  const expiresAt = Math.floor(Date.now() / 1000) + 1800;
  const payload = Buffer.from(JSON.stringify({sid: sessionId, gen: generation, aud: 'agent', exp: expiresAt})).toString('base64url');
  const token = `${payload}.${createHmac('sha256', credentials.browserToken).update(payload).digest('base64url')}`;
  const headers = {cookie: `mapache_access=${token}`, origin: origin.origin};
  const request = (path, requestHeaders = headers) => fetch(new URL(path, origin), {
    headers: requestHeaders, signal: AbortSignal.timeout(15000), redirect: 'manual',
  });
  assert.equal((await request('/agent/')).status, 200);
  const socketUrl = new URL('/shell', origin); socketUrl.protocol = 'wss:';
  const open = () => new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl, {headers, handshakeTimeout: 15000});
    socket.once('error', () => reject(new Error('fixture_socket_failed')));
    socket.once('open', () => resolve(socket));
  });
  function closedWithin(socket, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('fixture_socket_not_fenced')); }, ms);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      socket.on('error', () => {});
    });
  }
  async function setRouteEnabled(enabled) {
    await db.runTransaction(async tx => {
      const [current, route] = await Promise.all([tx.get(wsRef), tx.get(routeRef)]);
      assert.equal(current.data()?.ownerUid, 'vm-proof-owner');
      assert.equal(current.data()?.generation, generation);
      assert.equal(current.data()?.state, 'active');
      assert.equal(route.data()?.workspaceId, 'vm-proof-605');
      assert.equal(route.data()?.generation, generation);
      tx.update(routeRef, {enabled});
    });
  }
  // Prove gateway revocation while the old VM is still alive, independently of
  // TCP disconnects caused by deleting the instance.
  const fencedSocket = await open();
  const fenced = closedWithin(fencedSocket, 12000).then(() => true, () => false);
  const fenceStart = Date.now();
  try {
    await setRouteEnabled(false);
    assert.equal(await fenced, true, 'live route revocation did not close the connection');
    assert.equal((await request('/agent/')).status, 404);
  } finally {
    await setRouteEnabled(true);
    fencedSocket.terminate();
  }
  const fenceMs = Date.now() - fenceStart;
  console.log(JSON.stringify({phase: 'live_route_revocation', ok: true, fenceMs}));
  const replacementSocket = await open();
  const replaced = closedWithin(replacementSocket, 120000);
  // Attach a rejection handler immediately while the Compute operation runs.
  const replacementConnection = replaced.then(() => ({ok: true}), () => ({ok: false}));
  const start = Date.now();
  const computed = await command('scripts/vm-crossover-fixture.mjs', ['replace', String(generation), image]);
  assert.equal((await replacementConnection).ok, true, 'old connection survived compute replacement');
  const nextGeneration = generation + 1;
  const nextId = `vm-proof-605-g${nextGeneration}`;
  assert.equal(computed.descriptor.generation, nextGeneration);
  assert.equal(computed.disk.name, 'mapache-ws-efaf283eb879545a0e7ba4d3');
  await command('scripts/vm-gateway-fixture.mjs', ['route', String(nextGeneration)]);
  const nextCredentials = (await db.doc(`vmRuntimeCredentials_v2/${nextId}`).get()).data();
  assert.equal(nextCredentials.ownerUid, 'vm-proof-owner');
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await request('/runner/health', {'x-shutdown-token': nextCredentials.shutdownToken});
      if (response.ok) {
        const health = await response.json();
        if (health.sessionId === nextId && health.agentRuntime?.ready) { ready = true; break; }
      }
    } catch { /* Cold VM image pulls and startup are observed, never restarted. */ }
    if (attempt % 6 === 0) console.log(JSON.stringify({phase: 'waiting_for_new_agent', generation: nextGeneration, elapsedMs: Date.now() - start}));
    await wait(5000);
  }
  assert.ok(ready, 'replacement agent did not become ready');
  assert.ok(Date.now() / 1000 < expiresAt, 'old token expired before fencing assertion');
  assert.equal((await request('/agent/')).status, 404);
  assert.equal((await request('/runner/health', {'x-shutdown-token': credentials.shutdownToken})).status, 404);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl, {headers, handshakeTimeout: 15000});
    let denied = false;
    socket.once('open', () => { socket.terminate(); reject(new Error('old_websocket_accepted')); });
    socket.once('unexpected-response', (_req, response) => {
      const status = response.statusCode; denied = status === 404; response.resume(); socket.terminate();
      status === 404 ? resolve() : reject(new Error('unexpected_stale_websocket_status'));
    });
    socket.on('error', () => { if (!denied) reject(new Error('stale_websocket_probe_failed')); });
  });
  const probe = await command('scripts/vm-gateway-fixture.mjs', ['probe', String(nextGeneration)]);
  const result = {ok: true, fromGeneration: generation, generation: nextGeneration, fenceMs,
    replacementReadyMs: Date.now() - start, instance: computed.instance.name, disk: computed.disk.name,
    oldUnexpiredTokenRejected: true, oldHealthCredentialRejected: true, oldWebSocketRejected: true,
    reconnectedShell: probe.shellWebSocket, retainedPaths: probe.retainedShellPaths};
  await mkdir('artifacts/qa/vm-gateway-replacement', {recursive: true});
  await writeFile('artifacts/qa/vm-gateway-replacement/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
function command(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', () => {});
    child.once('error', () => reject(new Error(`fixture_subprocess_failed:${script}`)));
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`fixture_subprocess_failed:${script}:${code}`));
      else { try { resolve(JSON.parse(output)); } catch { reject(new Error('fixture_output_invalid')); } }
    });
  });
}
main().catch(error => { console.error(JSON.stringify({error: error.message})); process.exitCode = 1; });
