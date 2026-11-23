"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createVmLifecycleEffects} = require("./vmLifecycle.adapter");

function fixture() {
  const op = {operationId: "operation", workspaceId: "workspace", ownerUid: "owner", sessionId: "new", oldSessionId: "old",
    descriptor: {generation: 7}, gatewayHost: "fixture.example.com"};
  const ws = {ownerUid: "owner", generation: 7, currentSessionId: "new", activeOperationId: "operation"};
  const route = {workspaceId: "workspace", ownerUid: "owner", generation: 6};
  const docs = new Map([["vmRuntimes_v2/workspace", ws], ["vmGatewayRoutes_v2/fixture.example.com", route],
    ["vmRuntimeCredentials_v2/new", {ownerUid: "owner", shutdownToken: "distinct-control-token"}],
    ["vmRuntimeCredentials_v2/old", {ownerUid: "owner", shutdownToken: "old-control-token"}],
    ["vmRuntimes_v2/workspace/sessions/old", {leaseExpiresAt: Date.now() + 45000}]]);
  const ref = path => ({path, doc: id => ref(`${path}/${id}`), get: async () => ({data: () => docs.get(path)})});
  const writes = [];
  const db = {doc: ref, collection: ref, runTransaction: async fn => fn({get: r => r.get(), set: (r, data) => writes.push({path: r.path, data})})};
  const requests = [];
  const response = {ok: true, json: async () => ({sessionId: "new", agentRuntime: {ready: true}}), body: {cancel: async () => {}}};
  const observed = {instance: {privateAddress: "10.90.0.12"}};
  const effects = createVmLifecycleEffects({db, compute: {inspect: async () => observed},
    fetchImpl: async (url, options) => { requests.push({url, options}); return response; }});
  return {effects, ws, route, op, docs, writes, requests, response, observed};
}
test("only current operation can publish the owned private route", async () => {
  const f = fixture();
  await f.effects.publishRoute(f.op);
  assert.equal(f.writes[0].data.generation, 7);
  assert.equal(f.writes[0].data.address, "10.90.0.12");
  for (const change of [f => { f.ws.activeOperationId = "newer"; }, f => { f.route.ownerUid = "foreign"; },
    f => { f.route.generation = 8; }, f => { f.observed.instance.privateAddress = "169.254.169.254"; }]) {
    const blocked = fixture(); change(blocked);
    await assert.rejects(blocked.effects.publishRoute(blocked.op));
    assert.equal(blocked.writes.length, 0);
  }
});
test("control calls use exact authenticated routes and health requires current ready session", async () => {
  const f = fixture();
  assert.equal(await f.effects.health(f.op), true);
  assert.equal(f.requests[0].url, "https://fixture.example.com/runner/health");
  assert.equal(f.requests[0].options.headers["x-shutdown-token"], "distinct-control-token");
  assert.equal(f.requests[0].options.redirect, "error");
  f.response.json = async () => ({sessionId: "old", agentRuntime: {ready: true}});
  assert.equal(await f.effects.health(f.op), false);
  assert.deepEqual(await f.effects.quiesce(f.op), {ok: true, reason: "quiesced"});
  assert.equal(f.requests.at(-1).url, "https://fixture.example.com/shutdown");
  assert.equal(f.requests.at(-1).options.method, "POST");
  f.response.ok = false;
  assert.equal((await f.effects.quiesce(f.op)).ok, false);
  f.docs.get("vmRuntimes_v2/workspace/sessions/old").leaseExpiresAt = 0;
  const before = f.requests.length;
  assert.deepEqual(await f.effects.quiesce(f.op), {ok: false, reason: "lease_expired_delete_required"});
  assert.equal(f.requests.length, before);
});
