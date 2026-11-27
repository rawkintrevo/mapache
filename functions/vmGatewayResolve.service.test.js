"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {createHmac} = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const {execFileSync} = require("node:child_process");
const {generateKeyMaterial} = require("./remoteHost.service");
const {createVmGatewayResolveService} = require("./vmGatewayResolve.service");
const {createRuntimeDescriptor} = require("./runtimeProvider.helpers");

function fixture() {
  let time = Date.now();
  const host = "mapache-vm-gateway.example.com";
  const runtimeProvider = createRuntimeDescriptor({backend: "remote-libvirt", workspaceId: "workspace-1", ownerUid: "owner-1",
    guestResources: {vcpus: 3, memoryMiB: 4096, diskGiB: 40}, hostId: "host-1", guestIp: "192.168.250.12", generation: 3});
  runtimeProvider.state = "running";
  const workspace = {ownerUid: "owner-1", runtimeProvider};
  const session = {
    ownerUid: "owner-1",
    workspaceId: "workspace-1",
    runnerSessionId: "session-1",
    status: "running",
    agentRuntimeBootInstanceId: "boot-1",
    browserAccessTokenSecret: "browser-secret",
    shutdownToken: "shutdown-secret",
    runtimeProvider,
  };
  const remoteHost = {
    ownerUid: "owner-1",
    status: "ready",
    ready: true,
    address: "home.example.com",
    port: 22,
    managedUsername: "mapache",
    hostKeyFingerprint: "SHA256/abcdEFGHijklmnop",
  };
  const material = generateKeyMaterial();
  const privateHost = {privateKey: material.privateKey};
  const docs = new Map([
    ["workspaces/workspace-1", workspace],
    ["workspaces/workspace-1/sessions/session-1", session],
    ["remoteHosts/host-1", remoteHost],
    ["users/owner-1/private/remoteHosts/entries/host-1", privateHost],
  ]);
  const ref = (path) => ({
    path,
    doc: (id) => ref(`${path}/${id}`),
    collection: (id) => ref(`${path}/${id}`),
    get: async () => {
      const value = docs.get(path);
      return {exists: value !== undefined, data: () => value};
    },
  });
  const db = {
    collection: (name) => ref(name),
    runTransaction: async (callback) => callback({get: async (documentRef) => {
      const value = docs.get(documentRef.path);
      return {exists: value !== undefined, data: () => value};
    }}),
  };
  let addresses = [{address: "203.0.113.5"}];
  const resolve = createVmGatewayResolveService({db, now: () => time, allowedGatewayHosts: () => host,
    resolveHost: async () => addresses});
  const token = (claims = {}, secret = session.browserAccessTokenSecret) => {
    const payload = Buffer.from(JSON.stringify({
      aud: "agent", exp: Math.floor((time + 30_000) / 1000), gen: 3,
      sid: "session-1", uid: "owner-1", wid: "workspace-1", boot: session.agentRuntimeBootInstanceId, ...claims,
    })).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  };
  return {
    docs,
    host,
    session,
    workspace,
    material,
    setAddresses: (value) => { addresses = value; },
    remoteHost,
    token,
    resolve,
    call: (body = {}) => resolve({method: "POST", body: {
      host, path: "/agent/", token: token(), origin: `https://${host}`, ...body,
    }}),
    advance: (milliseconds) => { time += milliseconds; },
  };
}

test("shared gateway keeps remote workspace tokens separate from legacy Compute routes", async () => {
  const f = fixture();
  const time = Date.now();
  f.docs.set(`vmGatewayRoutes_v2/${f.host}`, {workspaceId: "compute-1", enabled: true,
    ownerUid: "compute-owner", generation: 3, sessionId: "compute-session", address: "10.90.0.3"});
  f.docs.set("vmRuntimes_v2/compute-1", {backend: "compute-engine", currentSessionId: "compute-session",
    ownerUid: "compute-owner", generation: 3, state: "active", leaseExpiresAt: time + 60_000});
  f.docs.set("vmRuntimes_v2/compute-1/sessions/compute-session", {ownerUid: "compute-owner",
    generation: 3, state: "active", leaseExpiresAt: time + 60_000});
  f.docs.set("vmRuntimeCredentials_v2/compute-session", {ownerUid: "compute-owner",
    generation: 3, browserToken: "compute-secret"});
  assert.equal((await f.call()).transport, "ssh");
  const legacyToken = f.token({wid: undefined, uid: undefined, sid: "compute-session"}, "compute-secret");
  assert.equal((await f.call({token: legacyToken})).transport, "direct");
  // A token signed by the legacy key cannot fall back from the remote branch.
  await assert.rejects(f.call({token: f.token({}, "compute-secret")}), /not_found/);
  await assert.rejects(f.call({token: f.token({wid: ""}, "compute-secret")}), /not_found/);
  f.docs.get(`vmGatewayRoutes_v2/${f.host}`).enabled = false;
  assert.equal((await f.call()).transport, "ssh");
  await assert.rejects(f.call({token: legacyToken}), /not_found/);
});

test("remote resolution is owner and generation fenced and returns only the SSH relay contract", async () => {
  const f = fixture();
  const result = await f.call();
  assert.deepEqual(result, {
    transport: "ssh",
    sshAddress: "203.0.113.5",
    sshPort: 22,
    sshUsername: "mapache",
    hostKeyFingerprint: "SHA256/abcdEFGHijklmnop",
    privateKey: result.privateKey,
    guestAddress: "192.168.250.12",
    guestPort: 8080,
    sessionId: "session-1",
    generation: 3,
    bootId: "boot-1",
    validUntil: result.validUntil,
  });
  assert.ok(result.validUntil <= Date.now() + 10_000);
  const directory = await fs.mkdtemp(`${os.tmpdir()}/mapache-gateway-key-test-`);
  try {
    const key = `${directory}/key`;
    await fs.writeFile(key, result.privateKey, {mode: 0o600});
    const publicKey = execFileSync("ssh-keygen", ["-y", "-f", key], {encoding: "utf8"}).trim();
    assert.equal(publicKey.split(" ").slice(0, 2).join(" "), f.material.publicKey.split(" ").slice(0, 2).join(" "));
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }

  for (const body of [
    {token: f.token({gen: 2})},
    {token: f.token({aud: "preview"})},
    {token: f.token({wid: "foreign"})},
    {token: f.token({}, "foreign-secret")},
    {host: "foreign.example.com"},
    {path: "/agent/../runner/health"},
    {path: "/runner/health", shutdownToken: "wrong"},
  ]) {
    await assert.rejects(f.call(body));
  }
});

test("workspace URL namespace must match the signed remote token", async () => {
  const f = fixture();
  for (const suffix of ["/", "/assets/app.js", "/ws"]) {
    assert.equal((await f.call({path: `/workspaces/workspace-1/agent${suffix}`})).transport, "ssh");
    await assert.rejects(f.call({path: `/workspaces/workspace-2/agent${suffix}`}), /not_found/);
  }
  for (const path of ["/workspaces/workspace-1/runner/health", "/workspaces/workspace%2D1/agent/",
    "/workspaces/workspace-1/other", "/workspaces//agent/"]) {
    await assert.rejects(f.call({path}));
  }
  await assert.rejects(f.call({path: "/workspaces/workspace-1/agent/", token: f.token({wid: undefined})}), /not_found/);
});

test("remote host and guest targets cannot be changed into arbitrary forwarding", async () => {
  const rebound = fixture();
  await rebound.call();
  rebound.setAddresses([{address: "10.0.0.4"}]);
  await assert.rejects(rebound.call(), /remote_host_address_disallowed/);
  for (const patch of [
    {guestIp: "10.0.0.4"},
    {guestIp: "127.0.0.1"},
    {guestIp: "192.168.250.255"},
  ]) {
    const f = fixture();
    f.workspace.runtimeProvider = {...f.workspace.runtimeProvider, ...patch};
    f.session.runtimeProvider = f.workspace.runtimeProvider;
    await assert.rejects(f.call(), /gateway_target_unavailable/);
  }
  const health = fixture();
  const healthResult = await health.call({path: "/runner/health", shutdownToken: "shutdown-secret"});
  assert.equal(healthResult.transport, "ssh");
});

test("restart rejects old and bootless links even when session, secret and disk generation are unchanged", async () => {
  const f = fixture();
  const oldToken = f.token();
  const first = await f.call({token: oldToken});
  assert.equal(first.bootId, "boot-1");
  f.session.agentRuntimeBootInstanceId = "boot-2";
  await assert.rejects(f.call({token: oldToken}), /not_found/);
  await assert.rejects(f.call({token: f.token({boot: undefined})}), /not_found/);
  await assert.rejects(f.call({token: f.token({boot: ""})}), /not_found/);
  const next = await f.call();
  assert.equal(next.bootId, "boot-2");
  assert.equal(next.generation, first.generation);
  delete f.session.agentRuntimeBootInstanceId;
  await assert.rejects(f.call(), /not_found/);
});

test("stopping or deleting a guest closes the route instead of implying host loss", async () => {
  for (const state of ["stopped", "deleting"]) {
    const f = fixture();
    f.session.status = state;
    await assert.rejects(f.call());
  }
  const f = fixture();
  f.remoteHost.status = "unreachable";
  await assert.rejects(f.call());
  f.advance(60_000);
  await assert.rejects(f.call());
});
