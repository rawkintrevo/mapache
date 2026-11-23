"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createHmac} = require("node:crypto");
const {createVmGatewayResolveService} = require("./vmGatewayResolve.service");

function fixture() {
  let time = 100000;
  const host = "fixture.example.com";
  const ws = {ownerUid: "owner", backend: "compute-engine", currentSessionId: "session", generation: 5,
    bootId: "boot", state: "active", leaseExpiresAt: time + 45000};
  const session = {...ws};
  const credentials = {ownerUid: "owner", generation: 5, browserToken: "browser-secret", shutdownToken: "health-secret"};
  const route = {enabled: true, workspaceId: "workspace", ownerUid: "owner", sessionId: "session", generation: 5, address: "10.90.0.12"};
  const docs = new Map([
    [`vmGatewayRoutes_v2/${host}`, route], ["vmRuntimes_v2/workspace", ws],
    ["vmRuntimes_v2/workspace/sessions/session", session], ["vmRuntimeCredentials_v2/session", credentials],
  ]);
  const ref = (path) => ({path, doc: (id) => ref(`${path}/${id}`), collection: (id) => ref(`${path}/${id}`)});
  const resolve = createVmGatewayResolveService({now: () => time, db: {
    collection: ref, runTransaction: (fn) => fn({get: async (r) => ({data: () => docs.get(r.path)})}),
  }});
  function token(extra = {}, secret = credentials.browserToken) {
    const body = Buffer.from(JSON.stringify({sid: "session", exp: 200, aud: "agent", gen: 5, ...extra})).toString("base64url");
    return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  }
  return {ws, session, credentials, route, token, advance: (ms) => { time += ms; },
    call: (body = {}) => resolve({method: "POST", body: {host, path: "/agent/", token: token(), ...body}})};
}

test("authorized routing returns only bounded target and authority, never credentials", async () => {
  const f = fixture();
  assert.deepEqual(await f.call(), {address: "10.90.0.12", port: 8080, sessionId: "session", generation: 5, bootId: "boot", validUntil: 110000});
  assert.equal((await f.call({path: "/shell", token: f.token({aud: undefined, gen: undefined})})).address, "10.90.0.12");
});

test("guessed hosts, foreign owners, expired and forged credentials fail closed", async () => {
  for (const body of [{host: "other.example.com"}, {token: ""}, {token: fixture().token({}, "foreign")},
    {token: fixture().token({sid: "other"})}, {token: fixture().token({exp: 99})},
    {origin: "https://evil.example"}, {host: "fixture.example.com:8080"}]) {
    await assert.rejects(fixture().call(body));
  }
  for (const field of ["route", "session", "credentials"]) {
    const f = fixture(); f[field].ownerUid = "foreign";
    await assert.rejects(f.call(), /not_found/);
  }
});

test("agent audience and generation required even through encoded path", async () => {
  for (const path of ["/agent", "/agent/", "/%61gent/", "/x/../agent/"]) {
    const f = fixture();
    await assert.rejects(f.call({path, token: f.token({aud: undefined, gen: undefined})}), /not_found/);
  }
  for (const claims of [{gen: 4}, {aud: "preview"}]) {
    const f = fixture(); await assert.rejects(f.call({path: "/shell", token: f.token(claims)}));
  }
});

test("replacement, stopping, lost lease and mismatched boot invalidate current connections", async () => {
  const changes = [f => { f.ws.generation++; }, f => { f.route.generation--; },
    f => { f.ws.currentSessionId = "replacement"; }, f => { f.session.bootId = "old"; },
    f => { f.ws.state = "stopping"; }, f => { f.session.state = "released"; }, f => f.advance(45001)];
  for (const change of changes) {
    const f = fixture(); await f.call(); change(f); await assert.rejects(f.call(), /not_found/);
  }
});

test("health requires distinct control credential; upstream cannot escape private subnet", async () => {
  const f = fixture();
  await assert.rejects(f.call({path: "/runner/health"}));
  await f.call({path: "/runner/health", shutdownToken: "health-secret", token: ""});
  await assert.rejects(f.call({path: "/agent/", shutdownToken: "health-secret", token: ""}));
  for (const address of ["169.254.169.254", "127.0.0.1", "10.90.1.1", "10.90.0.0", "10.90.0.255", "10.90.0.1:80", "example.com"]) {
    f.route.address = address; await assert.rejects(f.call(), /gateway_target_unavailable/);
  }
});
