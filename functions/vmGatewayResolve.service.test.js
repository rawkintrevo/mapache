"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {createHmac} = require("node:crypto");
const {createVmGatewayResolveService} = require("./vmGatewayResolve.service");
const {createRuntimeDescriptor} = require("./runtimeProvider.helpers");

function fixture() {
  let time = Date.now();
  const host = "mapache-vm-gateway.example.com";
  const runtimeProvider = createRuntimeDescriptor({backend: "remote-libvirt", workspaceId: "workspace-1", ownerUid: "owner-1",
    hostId: "host-1", guestIp: "192.168.250.12", generation: 3});
  runtimeProvider.state = "running";
  const workspace = {ownerUid: "owner-1", runtimeProvider};
  const session = {
    ownerUid: "owner-1",
    workspaceId: "workspace-1",
    runnerSessionId: "session-1",
    status: "running",
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
  const privateHost = {privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"};
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
  const resolve = createVmGatewayResolveService({db, now: () => time, allowedGatewayHosts: () => host});
  const token = (claims = {}, secret = session.browserAccessTokenSecret) => {
    const payload = Buffer.from(JSON.stringify({
      aud: "agent", exp: Math.floor((time + 30_000) / 1000), gen: 3,
      sid: "session-1", uid: "owner-1", wid: "workspace-1", ...claims,
    })).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  };
  return {
    host,
    session,
    workspace,
    remoteHost,
    token,
    resolve,
    call: (body = {}) => resolve({method: "POST", body: {
      host, path: "/agent/", token: token(), origin: `https://${host}`, ...body,
    }}),
    advance: (milliseconds) => { time += milliseconds; },
  };
}

test("remote resolution is owner and generation fenced and returns only the SSH relay contract", async () => {
  const f = fixture();
  const result = await f.call();
  assert.deepEqual(result, {
    transport: "ssh",
    sshAddress: "home.example.com",
    sshPort: 22,
    sshUsername: "mapache",
    hostKeyFingerprint: "SHA256/abcdEFGHijklmnop",
    privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    guestAddress: "192.168.250.12",
    guestPort: 8787,
    sessionId: "session-1",
    generation: 3,
    bootId: "3",
    validUntil: result.validUntil,
  });
  assert.ok(result.validUntil <= Date.now() + 10_000);

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

test("remote host and guest targets cannot be changed into arbitrary forwarding", async () => {
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
