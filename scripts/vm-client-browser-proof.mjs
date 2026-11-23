import {createRequire} from 'node:module';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const {WebSocket} = require('../vm-gateway/node_modules/ws');
const manifest = JSON.parse(await readFile('e2e/qa/cases/vm-client-routing.json', 'utf8'));
const directory = manifest.artifactsDir;
await mkdir(directory, {recursive: true});
const endpoint = 'http://127.0.0.1:9223';
const page = await (await fetch(`${endpoint}/json/new?about:blank`, {method: 'PUT'})).json();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
let sequence = 0; const pending = new Map(); const errors = []; const network = [];
socket.on('message', raw => {
  const event = JSON.parse(raw.toString());
  if (event.id) {
    const item = pending.get(event.id); pending.delete(event.id);
    if (item) { clearTimeout(item.timer); event.error ? item.reject(new Error(event.error.message)) : item.resolve(event.result); }
  } else if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
  else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') errors.push('console error');
  else if (event.method === 'Network.responseReceived') network.push({url: event.params.response.url, status: event.params.response.status});
  else if (event.method === 'Network.loadingFailed' && !event.params.canceled) errors.push(event.params.errorText);
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout:${method}`)); }, 15000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function waitText(text) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`document.querySelector('#session')?.textContent === ${JSON.stringify(text)}`)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`missing session state: ${text}`);
}
let failureReason;
try {
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', {width: 1100, height: 700, deviceScaleFactor: 1, mobile: false});
  await call('Page.navigate', {url: manifest.baseUrl});
  await waitText('s1: running');
  for (const [label, state] of [['Stop workspace', 's1: stopped'], ['Start workspace', 's2: running']]) {
    await evaluate(`document.querySelector('[aria-haspopup="menu"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await waitText(state);
  }
  await evaluate(`document.querySelector('#access').click()`);
  await new Promise(resolve => setTimeout(resolve, 200));
  const proof = await evaluate('window.vmProof');
  assert.equal(proof.legacyCalls, 0); assert.deepEqual(proof.errors, []);
  assert.deepEqual(proof.actions.map(a => [a.path.split('/').pop(), a.body.expectedGeneration]), [['pause', 1], ['start', 1], ['access', 2]]);
  assert.deepEqual(errors, []); assert.ok(network.every(response => response.status < 400));
  await writeFile(`${directory}/proof.json`, JSON.stringify(proof, null, 2));
  const screenshot = await call('Page.captureScreenshot', {format: 'png'});
  await writeFile(`${directory}/screen.png`, Buffer.from(screenshot.data, 'base64'));
} catch (error) { failureReason = error.message; }
finally {
  await writeFile(`${directory}/console.json`, JSON.stringify(errors));
  await writeFile(`${directory}/network.json`, JSON.stringify(network, null, 2));
  const result = {scenarioId: manifest.id, status: failureReason ? 'failed' : 'passed', scope: manifest.scope,
    evidence: directory, failureReason: failureReason || null};
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); socket.close();
  await fetch(`${endpoint}/json/close/${page.id}`);
  if (failureReason) process.exitCode = 1;
}
