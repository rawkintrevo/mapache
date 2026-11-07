"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {takeBrowserEgressConfig, createBrowserEgress, browserProxyArgs} = require("./browserEgress");
const config = {host: "office.example.com", port: 2222, user: "tunnel", hostKey: "ssh-ed25519 AAAA",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n"};
function fixture(overrides = {}) {
  const calls = [], writes = [], timers = [], children = [];
  const deps = {
    fs: {mkdtemp: async () => "/tmp/mapache-browser-egress-test", chmod: async (...args) => writes.push(args),
      writeFile: async (...args) => writes.push(args), rm: async (...args) => writes.push(args)},
    spawn: (...args) => {calls.push(args);const c = new EventEmitter();c.kill = signal => calls.push([signal]);children.push(c);return c;},
    probe: async () => true, delay: async () => {},
    setTimeout: (fn, ms) => {const t = {fn, ms, unref() {}};timers.push(t);return t;},
    clearTimeout: t => {t.cancelled = true;}, ...overrides,
  };
  return {service: createBrowserEgress(config, deps), calls, writes, timers, children};
}
test("take configuration removes secrets before children inherit environment, also on parse errors", () => {
  const env = {MAPACHE_BROWSER_SSH_EGRESS: JSON.stringify(config), KEEP: "yes"};
  assert.deepEqual(takeBrowserEgressConfig(env), config);
  assert.deepEqual(env, {KEEP: "yes"});
  for (const raw of ["broken", JSON.stringify({...config, user: "-root"})]) {
    const bad = {MAPACHE_BROWSER_SSH_EGRESS: raw};
    assert.throws(() => takeBrowserEgressConfig(bad), /invalid_configuration/);
    assert.equal(bad.MAPACHE_BROWSER_SSH_EGRESS, undefined);
  }
});
test("unconfigured runner has no proxy or processes", async () => {
  const s = createBrowserEgress(null, {spawn: () => {throw Error();}});
  await s.start();await s.stop();
  assert.deepEqual(browserProxyArgs(false), []);
  assert.equal(s.status().enabled, false);
});
test("SSH binds only loopback, pins host key, ignores user ssh config and protects private files", async () => {
  const f = fixture();await f.service.start();
  const [command, args, options] = f.calls[0];
  assert.equal(command, "ssh");
  assert.equal(args[args.indexOf("-D") + 1], "127.0.0.1:1080");
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("/dev/null"));
  assert.equal(options.stdio, "ignore");
  assert.ok(!args.some(a => a.includes("PRIVATE KEY")));
  const key = f.writes.find(w => w[0].endsWith("/key"));
  assert.equal(key[2].mode, 0o600);
  assert.equal(f.writes.find(w => w[0].endsWith("known_hosts"))[1], "[office.example.com]:2222 ssh-ed25519 AAAA\n");
  assert.equal(f.service.status().state, "ready");
  await f.service.stop();
  assert.ok(f.calls.some(c => c[0] === "SIGTERM"));
  assert.ok(f.writes.some(w => w[1]?.recursive));
});
test("outage retries are bounded in frequency and shutdown cancels reconnect", async () => {
  const f = fixture();await f.service.start();
  f.children[0].emit("exit", 255);
  assert.equal(f.service.status().state, "unavailable");
  const timer = f.timers.at(-1);assert.equal(timer.ms, 1000);
  timer.fn();assert.equal(f.children.length, 2);
  f.children[1].emit("error", Error("sensitive ssh diagnostic"));
  f.children[1].emit("exit", 255);
  assert.equal(f.timers.length, 2);
  await f.service.stop();assert.equal(f.timers[1].cancelled, true);
  f.timers[1].fn();assert.equal(f.children.length, 2);
});
test("startup failure cleans key files and reports only a fixed error", async () => {
  const f = fixture({probe: async () => false});
  await assert.rejects(f.service.start(), e => e.message === "browser_egress_start_failed");
  assert.ok(f.writes.some(w => w[1]?.recursive));
  assert.equal(f.service.status().state, "stopped");
});
test("browser proxy cannot silently fall back to direct internet, local previews stay local", () => {
  const args = browserProxyArgs(true);
  assert.ok(args.includes("--proxy-server=socks5://127.0.0.1:1080"));
  assert.ok(!args.join(" ").includes("direct://"));
  assert.ok(args.includes("--disable-quic"));
  assert.ok(args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(args.some(a => a.startsWith("--host-resolver-rules=MAP * ~NOTFOUND")));
});
