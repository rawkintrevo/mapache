#!/usr/bin/env node
// Fixed synthetic workspace and gateway only. Never emits access tokens.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const admin = require('../functions/node_modules/firebase-admin');
const {createComputeEngineService} = require('../functions/computeEngine.service');
const {createRuntimeDescriptor} = require('../functions/runtimeProvider.helpers');
const {WebSocket} = require('../vm-gateway/node_modules/ws');

async function main() {
  const [action = 'probe', rawGeneration = '5'] = process.argv.slice(2);
  const generation = Number(rawGeneration);
  assert.ok(['route', 'probe', 'browser'].includes(action) && Number.isSafeInteger(generation) && generation > 0);
  const workspaceId = 'vm-proof-605';
  const ownerUid = 'vm-proof-owner';
  let sessionId = `${workspaceId}-g${generation}`;
  const project = 'pi-agents-cloud';
  const run = JSON.parse(execFileSync('gcloud', ['run', 'services', 'describe', 'mapache-vm-gateway-v2',
    '--region', 'us-central1', '--project', project, '--format=json'], {encoding: 'utf8'}));
  const origin = new URL(run.status.url);
  assert.equal(origin.protocol, 'https:');
  assert.ok(origin.hostname.endsWith('.a.run.app'));
  admin.initializeApp({projectId: project});
  const db = admin.firestore();
  const wsRef = db.collection('vmRuntimes_v2').doc(workspaceId);
  const current = (await wsRef.get()).data();
  if (current?.generation === generation && current.ownerUid === ownerUid) sessionId = current.currentSessionId;
  if (action === 'route') {
    const descriptor = createRuntimeDescriptor({backend: 'compute-engine', workspaceId, ownerUid,
      region: 'us-central1', zone: 'us-central1-a', generation});
    const inspected = await createComputeEngineService({projectId: project}).inspect(descriptor);
    assert.equal(inspected.state, 'running');
    const instance = JSON.parse(execFileSync('gcloud', ['compute', 'instances', 'describe', inspected.instance.name,
      '--zone', descriptor.zone, '--project', project, '--format=json(networkInterfaces)'], {encoding: 'utf8'}));
    assert.equal(instance.networkInterfaces.length, 1);
    assert.equal((instance.networkInterfaces[0].accessConfigs || []).length, 0);
    assert.ok(instance.networkInterfaces[0].subnetwork.endsWith('/mapache-vm-v2-us-central1'));
    const address = instance.networkInterfaces[0].networkIP;
    assert.match(address, /^10\.90\.0\.[0-9]+$/);
    const routeRef = db.collection('vmGatewayRoutes_v2').doc(origin.hostname);
    await db.runTransaction(async tx => {
      const [ws, route] = await Promise.all([tx.get(wsRef), tx.get(routeRef)]);
      assert.equal(ws.data()?.ownerUid, ownerUid);
      assert.equal(ws.data()?.generation, generation);
      assert.equal(ws.data()?.currentSessionId, sessionId);
      if (route.exists) assert.equal(route.data().workspaceId, workspaceId);
      tx.set(routeRef, {enabled: true, workspaceId, ownerUid, sessionId, generation, address});
    });
    console.log(JSON.stringify({ok: true, action, host: origin.hostname, generation}));
    return;
  }
  const credentials = (await db.collection('vmRuntimeCredentials_v2').doc(sessionId).get()).data();
  assert.equal(credentials.ownerUid, ownerUid);
  assert.equal(credentials.generation, generation);
  function sign(claims, secret = credentials.browserToken) {
    const payload = Buffer.from(JSON.stringify({sid: sessionId, exp: Math.floor(Date.now() / 1000) + 120, ...claims})).toString('base64url');
    return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  }
  const request = (path, headers = {}) => fetch(new URL(path, origin), {headers, signal: AbortSignal.timeout(30000), redirect: 'manual'});
  if (action === 'browser') {
    const {browserProof} = await import('./vm-gateway-browser-proof.mjs');
    console.log(JSON.stringify(await browserProof({origin, token: sign({aud: 'agent', gen: generation})})));
    return;
  }
  assert.equal((await request('/agent/')).status, 404);
  assert.equal((await request('/agent/', {cookie: `mapache_access=${sign({aud: 'agent', gen: generation}, 'foreign')}`})).status, 404);
  assert.equal((await request('/agent/', {cookie: `mapache_access=${sign({aud: 'agent', gen: generation - 1})}`})).status, 404);
  assert.equal((await request('/agent/', {cookie: `mapache_access=${sign({})}`})).status, 404);
  const cookie = `mapache_access=${sign({aud: 'agent', gen: generation})}`;
  assert.equal((await request('/agent/', {cookie, origin: 'https://foreign.example'})).status, 404);
  const page = await request('/agent/', {cookie});
  assert.equal(page.status, 200);
  const html = await page.text();
  const bundles = [...html.matchAll(/(?:src|href)="([^"\s]+\.js)"/g)].map(match => match[1]);
  assert.ok(bundles.length > 0);
  for (const bundle of bundles) {
    const url = new URL(bundle, new URL('/agent/', origin));
    assert.equal(url.origin, origin.origin);
    assert.equal((await request(url.pathname, {cookie})).status, 200);
  }
  assert.equal((await request('/runner/health')).status, 404);
  const health = await request('/runner/health', {'x-shutdown-token': credentials.shutdownToken});
  assert.equal(health.status, 200);
  const data = await health.json();
  assert.equal(data.sessionId, sessionId);
  assert.equal(data.agentRuntime.ready, true);
  // Exercise a real PTY through TLS and the gateway, not only an upgrade status.
  await new Promise((resolve, reject) => {
    const socketUrl = new URL('/shell', origin); socketUrl.protocol = 'wss:';
    const socket = new WebSocket(socketUrl, {headers: {cookie, origin: origin.origin}});
    let output = '';
    let finished = false;
    const timer = setTimeout(() => finish(new Error('gateway_shell_timeout')), 20000);
    function finish(error) {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve();
    }
    socket.on('error', () => finish(new Error('gateway_shell_connection_failed')));
    socket.on('open', () => socket.send(JSON.stringify({type: 'data',
      data: "printf '\\nVM_GATEWAY_%s\\n' PROOF; pwd; printf '%s\\n' \"$HOME\"\r"})));
    socket.on('message', raw => {
      try { const message = JSON.parse(raw.toString()); if (message.type === 'data') output += message.data; } catch { return; }
      if (output.includes('VM_GATEWAY_PROOF') && output.includes('/var/lib/mapache/workspace/workspace') &&
          output.includes('/var/lib/mapache/workspace/home')) finish();
    });
    socket.on('close', () => { if (!finished) finish(new Error('gateway_shell_closed_early')); });
  });
  console.log(JSON.stringify({ok: true, action, host: origin.hostname, generation, agentReady: true,
    healthStatus: 200, bundles: bundles.length, shellWebSocket: true, retainedShellPaths: true,
    unauthorizedRejected: true, staleGenerationRejected: true}));
}
main().catch(error => { console.error(JSON.stringify({error: String(error.code || 'gateway_fixture_failed'), message: error.message})); process.exitCode = 1; });
