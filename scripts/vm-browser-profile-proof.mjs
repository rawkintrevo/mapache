import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

// Run inside `unshare --user --map-root-user --net`. Never launch a restored
// real profile with network access or attach this proof to somebody's Chrome.
const source = path.resolve('artifacts/qa/vm-browser-archive-import/stage/tree/browser/profile');
const output = path.resolve(process.argv[2] || 'artifacts/qa/vm-browser-profile-proof');
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fingerprint(root) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const target = path.join(root, relative); const stat = await fs.lstat(target);
    hash.update(JSON.stringify([relative, stat.mode, stat.size]));
    if (stat.isDirectory()) for (const name of (await fs.readdir(target)).sort()) await visit(path.join(relative, name));
    else if (stat.isSymbolicLink()) hash.update(await fs.readlink(target));
    else if (stat.isFile()) {
      const handle = await fs.open(target, 'r');
      for await (const chunk of handle.createReadStream()) hash.update(chunk);
    } else throw Error('unsupported_profile_entry');
  }
  await visit(''); return hash.digest('hex');
}
const sqliteCheck = `
import os,sys,json,sqlite3,pathlib
root=pathlib.Path(sys.argv[1]); count=0; failed=0
for parent,dirs,files in os.walk(root,followlinks=False):
 for name in files:
  p=pathlib.Path(parent)/name
  if p.is_symlink(): continue
  with p.open('rb') as f: header=f.read(16)
  if header!=b'SQLite format 3\\x00': continue
  count+=1
  try:
   con=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=5)
   try: ok=con.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
   finally: con.close()
   if not ok: failed+=1
  except Exception: failed+=1
print(json.dumps({'databases':count,'failed':failed}))
`;
async function checkDatabases(profile) {
  const {stdout} = await exec('python3', ['-c', sqliteCheck, profile], {timeout: 30000, maxBuffer: 10000});
  const result = JSON.parse(stdout); assert.ok(result.databases > 0 && result.failed === 0, 'profile_database_integrity'); return result;
}

let temporary; let browser; let before; let failure; const pending = new Map(); const observations = {};
try {
  assert.match(process.env.VM_PROOF_PARENT_NETNS || '', /^net:\[\d+\]$/, 'network_namespace_required');
  assert.notEqual(await fs.readlink('/proc/self/ns/net'), process.env.VM_PROOF_PARENT_NETNS, 'network_namespace_required');
  assert.ok(Object.entries(os.networkInterfaces()).every(([name]) => name === 'lo'), 'external_interface_forbidden');
  observations.networkIsolated = true;
  before = await fingerprint(source);
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mapache-profile-proof-'));
  const profile = path.join(temporary, 'profile');
  await fs.cp(source, profile, {recursive: true, preserveTimestamps: true, verbatimSymlinks: true});
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) await fs.rm(path.join(profile, name), {force: true});
  for (const name of ['Local State', 'Default/Preferences']) assert.equal(typeof JSON.parse(await fs.readFile(path.join(profile, name), 'utf8')), 'object');
  observations.beforeLaunch = await checkDatabases(profile);
  browser = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-pipe',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--disable-extensions', '--disable-component-update', '--no-startup-window', '--password-store=basic'],
  {detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']});
  const exited = new Promise(resolve => {
    browser.once('exit', (code, signal) => resolve({code, signal}));
    browser.once('error', () => resolve({code: null, signal: 'spawn_failed'}));
  });
  browser.stdio[3].on('error', () => {
    for (const [id, item] of pending) { clearTimeout(item.timer); pending.delete(id); item.reject(Error('devtools_command_failed')); }
  });
  let sequence = 0; let buffer = ''; let exceptions = 0;
  browser.stdio[4].on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\0')) {
      const end = buffer.indexOf('\0'); const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!raw) continue;
      const event = JSON.parse(raw);
      if (event.method === 'Runtime.exceptionThrown') exceptions++;
      const item = pending.get(event.id);
      if (item) { pending.delete(event.id); clearTimeout(item.timer); event.error ? item.reject(Error('devtools_command_failed')) : item.resolve(event.result); }
    }
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error('devtools_timeout')); }, 15000);
    pending.set(id, {resolve, reject, timer});
    browser.stdio[3].write(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}) + '\0');
  });
  observations.browser = (await call('Browser.getVersion')).product;
  const {targetId} = await call('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await call('Target.attachToTarget', {targetId, flatten: true});
  await call('Page.enable', {}, sessionId); await call('Runtime.enable', {}, sessionId);
  await call('Page.navigate', {url: 'data:text/html,<title>Profile recovery proof</title><h1>Restored profile opened</h1>'}, sessionId);
  let title;
  for (let i = 0; i < 50; i++) {
    title = (await call('Runtime.evaluate', {expression: 'document.title', returnByValue: true}, sessionId)).result.value;
    if (title === 'Profile recovery proof') break;
    await delay(100);
  }
  assert.equal(title, 'Profile recovery proof'); assert.equal(exceptions, 0);
  observations.pageOpened = true;
  await call('Browser.close').catch(() => {});
  const closed = await Promise.race([exited, delay(5000).then(() => null)]);
  assert.equal(closed?.code, 0, 'browser_close_timeout');
  observations.browserExitCode = closed.code;
  observations.afterClose = await checkDatabases(profile);
} catch (error) {
  const known = new Set(['network_namespace_required', 'external_interface_forbidden', 'profile_database_integrity', 'devtools_command_failed', 'devtools_timeout', 'browser_close_timeout']);
  failure = known.has(error.message) ? error.message : 'profile_proof_failed';
} finally {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('proof_closed')); }
  if (browser?.pid) { try { process.kill(-browser.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ||= 'browser_cleanup_failed'; } }
  for (const stream of browser?.stdio || []) stream?.destroy();
  if (temporary) await fs.rm(temporary, {recursive: true, force: true});
  if (before) {
    observations.sourceUnchanged = await fingerprint(source) === before;
    if (!observations.sourceUnchanged) failure ||= 'source_changed';
  }
  await fs.mkdir(output, {recursive: true, mode: 0o700});
  const result = {scenarioId: 'vm-browser-profile-proof', status: failure ? 'failed' : 'passed', observations,
    scope: 'isolated local Chrome/profile and SQLite integrity; not VM desktop, encrypted credential recovery, external login or complete cutover', failureReason: failure || null};
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2), {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify(result)); if (failure) process.exitCode = 1;
}
