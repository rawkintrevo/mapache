import {createRequire} from 'node:module';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const {WebSocket} = require('../vm-gateway/node_modules/ws');

export async function liveShellProof({customToken}) {
  const manifest = JSON.parse(await readFile('e2e/qa/cases/vm-live-shell.json', 'utf8'));
  const directory = manifest.artifactsDir; await mkdir(directory, {recursive: true});
  let endpoint;
  for (const port of [9222, 9223]) {
    const candidate = `http://127.0.0.1:${port}`;
    try {
      const pages = await (await fetch(`${candidate}/json`)).json();
      if (pages.some(page => page.type === 'page' && page.webSocketDebuggerUrl)) {
        endpoint = candidate;
        break;
      }
    } catch { /* Try the isolated fallback port. */ }
  }
  if (!endpoint) throw new Error('chrome_devtools_unavailable');
  const page = await (await fetch(`${endpoint}/json/new?about:blank`, {method: 'PUT'})).json();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let serial = 0; const pending = new Map(); const errors = []; const network = []; const expectedCandidates = new Map();
  const contexts = new Map();
  const clean = raw => { const url = new URL(raw); return `${url.origin}${url.pathname}`; };
  socket.on('message', raw => {
    const event = JSON.parse(raw.toString());
    if (event.id) {
      const item = pending.get(event.id); pending.delete(event.id);
      if (item) { clearTimeout(item.timer); event.error ? item.reject(new Error(event.error.message)) : item.resolve(event.result); }
    } else if (event.method === 'Runtime.executionContextCreated') {
      const context = event.params.context;
      contexts.set(`${event.sessionId || ''}:${context.id}`, {...context, sessionId: event.sessionId});
    } else if (event.method === 'Runtime.executionContextsCleared') {
      for (const [key, context] of contexts) if (context.sessionId === event.sessionId) contexts.delete(key);
    } else if (event.method === 'Runtime.executionContextDestroyed') contexts.delete(`${event.sessionId || ''}:${event.params.executionContextId}`);
    else if (event.method === 'Runtime.exceptionThrown') errors.push({type: 'exception', text: event.params.exceptionDetails.text});
    else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') errors.push({type: 'console-error'});
    else if (event.method === 'Network.responseReceived') {
      const entry = {url: clean(event.params.response.url), status: event.params.response.status};
      if (entry.status === 404 && entry.url.endsWith('/__/firebase/init.json')) entry.expected = 'local-vite-firebase-config';
      network.push(entry);
      if (entry.status === 409 && entry.url.endsWith('/agent/api/device-center/shared-rooms')) expectedCandidates.set(event.params.requestId, {entry, sessionId: event.sessionId});
    } else if (event.method === 'Network.loadingFailed' && !event.params.canceled) errors.push({type: 'network-failed', text: event.params.errorText});
  });
  function call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout:${method}`)); }, 30000);
      pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  async function evaluate(expression, sessionId, contextId) {
    const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, ...(contextId ? {contextId} : {})}, sessionId);
    if (result.exceptionDetails) throw new Error('browser_evaluation_failed'); return result.result.value;
  }
  let failureReason; let observations;
  try {
    await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
    await call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
    await call('Page.navigate', {url: manifest.baseUrl});
    await new Promise(resolve => setTimeout(resolve, 2000));
    // The production app has initialized the default Firebase app. Import the
    // same Vite dependency module, retaining the token only in this evaluation.
    assert.equal(await evaluate(`(async () => {
      const sdk = await import('/node_modules/.vite/deps/firebase_auth.js');
      const result = await sdk.signInWithCustomToken(sdk.getAuth(), ${JSON.stringify(customToken)});
      return result.user.uid === 'vm-proof-owner';
    })()`), true);
    let vmWorkspaceListed = false;
    for (let i = 0; i < 90; i++) {
      vmWorkspaceListed = await evaluate(`Boolean([...document.querySelectorAll('#topbar-workspace-select option')]
        .find(option => option.value === 'vm-proof-605'))`);
      if (vmWorkspaceListed) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(vmWorkspaceListed, true, 'vm-proof-605 was not listed in the signed-in shell');
    await evaluate(`(() => {
      const select = document.querySelector('#topbar-workspace-select');
      select.value = 'vm-proof-605';
      select.dispatchEvent(new Event('change', {bubbles: true}));
      return true;
    })()`);
    for (let i = 0; i < 90; i++) {
      observations = await evaluate(`(() => ({text: document.body.innerText,
        running: !!document.querySelector('[aria-label="Workspace power controls: running"]'),
        agentFrame: [...document.querySelectorAll('iframe')].some(frame => {
          try { const u = new URL(frame.src); return u.hostname === 'mapache-vm-gateway-v2-pxyyg7zwda-uc.a.run.app' && u.pathname === '/agent/'; } catch { return false; }
        })}))()`);
      if (observations.running && observations.agentFrame) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    let frame; let context;
    for (let i = 0; i < 90; i++) {
      const targets = await call('Target.getTargets');
      frame = targets.targetInfos.find(target => target.type === 'iframe' && target.url.startsWith('https://mapache-vm-gateway-v2-pxyyg7zwda-uc.a.run.app/agent/'));
      context = [...contexts.values()].find(item => item.origin === 'https://mapache-vm-gateway-v2-pxyyg7zwda-uc.a.run.app' && item.auxData?.isDefault);
      if (frame || context) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    let attached = {};
    if (frame) {
      attached = await call('Target.attachToTarget', {targetId: frame.targetId, flatten: true});
      await call('Runtime.enable', {}, attached.sessionId); await call('Network.enable', {}, attached.sessionId);
    } else {
      assert.ok(context, 'Agent iframe execution context absent');
      attached = {sessionId: context.sessionId, contextId: context.id};
    }
    let connected = false;
    for (let i = 0; i < 90; i++) {
      connected = await evaluate(`(() => {
        const input = document.querySelector('textarea, [contenteditable=true]');
        return !!input && !document.body.innerText.includes('Connecting to pi-web-ui server') &&
          !String(input.getAttribute('placeholder') || '').toLowerCase().includes('connecting');
      })()`, attached.sessionId, attached.contextId);
      if (connected) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(connected, true, 'Agent connection did not settle');
    let meters = false;
    for (let i = 0; i < 40; i++) {
      meters = await evaluate(`['CPU', 'RAM'].every(label => {
        const meter = document.querySelector('[aria-label="' + label + ' utilization"]');
        return meter && meter.hasAttribute('aria-valuenow');
      })`);
      if (meters) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(meters, true, 'Live resource meters have no samples');
    const setup = await evaluate(`(() => {
      const modal = document.querySelector('.setup-modal');
      if (!modal) return 'absent';
      if (!modal.innerText.includes('Provider credentials are managed in Mapache Authentication Center')) return 'unexpected';
      modal.querySelector('.modal-close').click(); return 'managed-no-credentials';
    })()`, attached.sessionId, attached.contextId);
    assert.notEqual(setup, 'unexpected');
    let settled = 0;
    for (let i = 0; i < 90 && settled < 3; i++) {
      const ready = await evaluate(`(() => {
        const text = document.body.innerText;
        return !!document.querySelector('textarea, [contenteditable=true]') && text.includes('Connected') &&
          !text.includes('Loading session') && !text.includes('Connecting to pi-web-ui server');
      })()`, attached.sessionId, attached.contextId);
      settled = ready ? settled + 1 : 0;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(settled, 3, 'Agent session loading did not settle');
    observations.text = await evaluate('document.body.innerText');
    await new Promise(resolve => setTimeout(resolve, 1000));
    for (const [id, {entry, sessionId}] of expectedCandidates) {
      const response = await call('Network.getResponseBody', {requestId: id}, sessionId).catch(() => null);
      if (response) {
        const body = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body);
        if (body.code === 'NOT_PAIRED') entry.expected = true;
      }
    }
    assert.equal(observations.running, true, 'running power control absent');
    assert.equal(observations.agentFrame, true, 'live VM Agent iframe absent');
    assert.ok(network.some(n => n.url.endsWith('/vmApi_v2/workspaces') && n.status === 200));
    assert.ok(network.some(n => n.url.endsWith('/vm-proof-605/access') && n.status === 200));
    assert.ok(!network.some(n => n.url.includes('/api/workspaces/vm-proof-605')));
    assert.deepEqual(errors, []);
    assert.ok(network.every(n => n.status < 400 || n.expected), 'unexpected HTTP error');
  } catch (error) { failureReason = error.message; }
  finally {
    const screenshot = await call('Page.captureScreenshot', {format: 'png'});
    await writeFile(`${directory}/shell.png`, Buffer.from(screenshot.data, 'base64'));
    await writeFile(`${directory}/snapshot.txt`, observations?.text || '');
    await writeFile(`${directory}/console.json`, JSON.stringify(errors, null, 2));
    await writeFile(`${directory}/network.json`, JSON.stringify(network, null, 2));
    await evaluate(`(async () => { const sdk = await import('/node_modules/.vite/deps/firebase_auth.js'); await sdk.signOut(sdk.getAuth()); return true; })()`).catch(() => {});
    socket.close(); await fetch(`${endpoint}/json/close/${page.id}`);
  }
  const result = {scenarioId: manifest.id, status: failureReason ? 'failed' : 'passed', evidence: directory, failureReason: failureReason || null};
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  if (failureReason) throw new Error(failureReason);
  return result;
}
