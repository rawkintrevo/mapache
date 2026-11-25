import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
const require = createRequire(import.meta.url);
const {WebSocket} = require('../vm-gateway/node_modules/ws');

export async function browserProof({origin, token}) {
  const directory = 'artifacts/qa/vm-gateway-fixture';
  await mkdir(directory, {recursive: true});
  let endpoint;
  for (const port of [9222, 9223]) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (pages.some(p => p.type === 'page' && p.webSocketDebuggerUrl)) { endpoint = `http://127.0.0.1:${port}`; break; }
    } catch { /* Try the isolated fallback port. */ }
  }
  if (!endpoint) throw new Error('chrome_devtools_unavailable');
  const page = await (await fetch(`${endpoint}/json/new?about:blank`, {method: 'PUT'})).json();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const pending = new Map();
  const errors = [];
  const network = [];
  const pendingResponses = new Map();
  let sequence = 0;
  const cleanUrl = raw => { try { const u = new URL(raw); return `${u.origin}${u.pathname}`; } catch { return 'invalid-url'; } };
  socket.on('message', raw => {
    const event = JSON.parse(raw.toString());
    if (event.id) {
      const item = pending.get(event.id); pending.delete(event.id);
      if (item) { clearTimeout(item.timer); event.error ? item.reject(new Error(event.error.message)) : item.resolve(event.result); }
    } else if (event.method === 'Runtime.exceptionThrown') errors.push({type: 'exception', text: event.params.exceptionDetails.text});
    else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') errors.push({type: 'console-error'});
    else if (event.method === 'Network.responseReceived') {
      const entry = {url: cleanUrl(event.params.response.url), status: event.params.response.status};
      network.push(entry);
      if (entry.status === 409 && entry.url === new URL('/agent/api/device-center/shared-rooms', origin).href) pendingResponses.set(event.params.requestId, entry);
    }
    else if (event.method === 'Network.loadingFailed' && !event.params.canceled) errors.push({type: 'network-failed', text: event.params.errorText});
    else if (event.method === 'Network.webSocketHandshakeResponseReceived') network.push({url: 'websocket-handshake', status: event.params.response.status});
    else if (event.method === 'Network.webSocketFrameError') errors.push({type: 'websocket-error', text: event.params.errorMessage});
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp_timeout:${method}`)); }, 10000);
      pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
    });
  }
  let failureReason;
  try {
    await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
    await call('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
    await call('Network.setCookie', {name: 'mapache_access', value: token, url: origin.origin, path: '/', secure: true, httpOnly: true, sameSite: 'Lax'});
    await call('Page.navigate', {url: new URL('/agent/', origin).href});
    let rendered = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = await call('Runtime.evaluate', {expression: "Boolean(document.body?.innerText.length > 20 && !document.body.innerText.includes('Loading session') && document.querySelector('textarea, [contenteditable=true]'))", returnByValue: true});
      if (result.result.value) { rendered = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    // Give streaming connection setup and late bundle requests time to settle.
    await new Promise(resolve => setTimeout(resolve, 2000));
    const setup = await call('Runtime.evaluate', {expression: `(() => {
      const modal = document.querySelector('.setup-modal');
      if (!modal) return 'absent';
      if (!modal.innerText.includes('Provider credentials are managed in Mapache Authentication Center')) return 'unexpected';
      modal.querySelector('.modal-close').click(); return 'managed-no-credentials';
    })()`, returnByValue: true});
    if (setup.result.value === 'unexpected') failureReason = 'unexpected_credential_setup';
    await new Promise(resolve => setTimeout(resolve, 200));
    const screenshot = await call('Page.captureScreenshot', {format: 'png'});
    await writeFile(`${directory}/agent.png`, Buffer.from(screenshot.data, 'base64'));
    const snapshot = await call('Runtime.evaluate', {expression: 'document.body.innerText', returnByValue: true});
    await writeFile(`${directory}/snapshot.txt`, snapshot.result.value || '');
    // The synthetic machine is deliberately not paired with an upstream Device
    // Center hub. Only its precise documented NOT_PAIRED response is expected.
    for (const [requestId, entry] of pendingResponses) {
      try {
        const response = await call('Network.getResponseBody', {requestId});
        const body = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body);
        if (body.code === 'NOT_PAIRED') entry.expected = 'unpaired-synthetic-device';
      } catch { /* Unreadable errors remain failures. */ }
    }
    if (!rendered) failureReason = 'agent_composer_not_rendered';
    else if (errors.length || network.some(n => n.status >= 400 && !n.expected)) failureReason = 'browser_console_or_network_failure';
  } finally {
    await call('Network.deleteCookies', {name: 'mapache_access', url: origin.origin}).catch(() => {});
    socket.close();
    await fetch(`${endpoint}/json/close/${page.id}`);
  }
  await writeFile(`${directory}/console.json`, JSON.stringify(errors, null, 2));
  await writeFile(`${directory}/network.json`, JSON.stringify(network, null, 2));
  const result = {scenarioId: 'vm-gateway-fixture', status: failureReason ? 'failed' : 'passed',
    observations: {cdp: endpoint, responses: network.length}, evidence: [`${directory}/agent.png`, `${directory}/console.json`, `${directory}/network.json`], failureReason};
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  if (failureReason) throw new Error(failureReason);
  return result;
}
