"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createVmApiService, ACCESS_TTL_MS} = require("./vmApi.service");
const {createBrowserAccessVerifier} = require("../session-runner/lib/browserAccess");

function fixture() {
  const time = 100000;
  const ws = {ownerUid: "owner", backend: "compute-engine", apiEnabled: true, lifecycleReadyGeneration: 7,
    generation: 7, state: "active", currentSessionId: "session", bootId: "boot", leaseExpiresAt: time + 45000,
    gatewayHost: "fixture.example.com", privateField: "not-for-clients"};
  const session = {ownerUid: "owner", generation: 7, state: "active", bootId: "boot", leaseExpiresAt: time + 45000};
  const credentials = {ownerUid: "owner", generation: 7, browserToken: "b".repeat(64), controlToken: "control-secret", shutdownToken: "shutdown-secret"};
  const route = {ownerUid: "owner", workspaceId: "workspace", generation: 7, sessionId: "session", enabled: true, address: "10.90.0.12"};
  const docs = new Map([["vmRuntimes_v2/workspace", ws], ["vmRuntimes_v2/workspace/sessions/session", session],
    ["vmRuntimeCredentials_v2/session", credentials], ["vmGatewayRoutes_v2/fixture.example.com", route]]);
  const ref = path => ({path, doc: id => ref(`${path}/${id}`), collection: id => ref(`${path}/${id}`), get: async () => ({data: () => docs.get(path)})});
  const calls = [];
  const service = createVmApiService({now: () => time, db: {collection: ref, runTransaction: fn => fn({get: r => r.get()})},
    requireUser: async req => {
      if (!req.authenticatedUid) throw new Error("invalid_auth_token");
      if (req.authenticatedUid === "not-allowed") throw new Error("app_access_not_allowed");
      return {uid: req.authenticatedUid};
    }, lifecycle: {request: async args => { calls.push(args); return {operationId: "operation", status: "pending"}; }}});
  return {ws, session, credentials, route, docs, calls, time,
    call: (path = "/workspaces/workspace/access", body = {expectedGeneration: 7}, method = "POST", uid = "owner") =>
      service({path, body, method, authenticatedUid: uid})};
}

test("Firebase identity and app admission precede every owner-scoped operation", async () => {
  const f = fixture();
  for (const uid of ["", "not-allowed", "foreign"]) await assert.rejects(f.call(undefined, undefined, undefined, uid));
  f.ws.apiEnabled = false;
  await assert.rejects(f.call(), /not_found/);
  await assert.rejects(f.call("/workspaces/workspace/pause", {expectedGeneration: 7, requestId: "pause"}), /not_found/);
  assert.equal(f.calls.length, 0);
});

test("access URLs are compatible with both real runner verifiers and never include stored credentials", async () => {
  const f = fixture(); const {status, body} = await f.call();
  assert.equal(status, 200);
  const tokens = [body.agentUrl, body.terminalUrl, body.previewUrl].map(url => new URL(url).searchParams.get("mapache_access"));
  assert.equal(new Set(tokens).size, 1);
  const base = {secret: f.credentials.browserToken, sessionId: "session", now: () => f.time};
  assert.equal(createBrowserAccessVerifier(base).verify(tokens[0]), true);
  assert.equal(createBrowserAccessVerifier({...base, audience: "agent", generation: 7, requireAudience: true, requireGeneration: true}).verify(tokens[0]), true);
  assert.equal(createBrowserAccessVerifier({...base, audience: "agent", generation: 6}).verify(tokens[0]), false);
  assert.equal(Date.parse(body.expiresAt) - f.time, ACCESS_TTL_MS);
  assert.equal(body.browserUrl, null);
  for (const secret of [f.credentials.browserToken, f.credentials.controlToken, f.credentials.shutdownToken, "10.90.0.12"]) assert.ok(!JSON.stringify(body).includes(secret));
});

test("stale generation, readiness, leases, ownership and route bindings cannot mint access", async () => {
  await assert.rejects(fixture().call(undefined, {expectedGeneration: 6}), /vm_generation_mismatch/);
  for (const change of [f => { f.ws.state = "stopping"; }, f => { f.ws.activeOperationId = "pause"; },
    f => { f.ws.lifecycleReadyGeneration = 6; }, f => { f.ws.leaseExpiresAt = 0; }, f => { f.session.bootId = "stale"; },
    f => { f.session.leaseExpiresAt = 0; }, f => { f.credentials.ownerUid = "foreign"; },
    f => { f.route.workspaceId = "foreign"; }, f => { f.route.generation = 6; }, f => { f.route.enabled = false; },
    f => { f.route.address = "169.254.169.254"; }]) {
    const f = fixture(); change(f); await assert.rejects(f.call());
  }
});

test("lifecycle dispatch derives owner from auth and forbids caller-selected runtime inputs", async () => {
  const f = fixture();
  const result = await f.call("/workspaces/workspace/replace", {expectedGeneration: 7, requestId: "request"});
  assert.equal(result.status, 202);
  assert.deepEqual(f.calls[0], {workspaceId: "workspace", ownerUid: "owner", action: "replace", expectedGeneration: 7, requestId: "request", requireApiAdmission: true});
  for (const extra of [{ownerUid: "foreign"}, {runnerImage: "attacker"}, {address: "169.254.169.254"}, {allowCreateDisk: true}]) {
    await assert.rejects(f.call("/workspaces/workspace/start", {expectedGeneration: 7, requestId: "request", ...extra}), /invalid_vm_request/);
  }
  assert.equal(f.calls.length, 1);
});

test("status exposes only safe fields and operation status cannot cross workspace ownership", async () => {
  const f = fixture();
  const result = await f.call("/workspaces/workspace", {}, "GET");
  assert.equal(result.body.workspace.ready, true);
  assert.ok(!JSON.stringify(result.body).includes("not-for-clients"));
  f.ws.leaseExpiresAt = 0;
  assert.equal((await f.call("/workspaces/workspace", {}, "GET")).body.workspace.ready, false);
  const id = "a".repeat(64);
  f.docs.set(`vmLifecycleOperations_v2/${id}`, {ownerUid: "owner", workspaceId: "foreign", descriptor: {generation: 7}});
  await assert.rejects(f.call(`/workspaces/workspace/operations/${id}`, {}, "GET"), /not_found/);
});
