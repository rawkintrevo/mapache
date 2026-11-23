"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createVmReadService} = require("./vmRead.service");
const {createVmApiService} = require("./vmApi.service");

function fixture() {
  const ws = {ownerUid: "owner", apiEnabled: true, backend: "compute-engine", generation: 8, state: "active",
    currentSessionId: "s8", bootId: "boot", leaseExpiresAt: 5000, lifecycleReadyGeneration: 8,
    gatewayHost: "fixture.example.com", internalSecret: "never-expose"};
  const session = {ownerUid: "owner", generation: 8, state: "active", bootId: "boot", leaseExpiresAt: 5000, controlTokenHash: "never-expose"};
  const docs = new Map([["vmRuntimes_v2/a", ws], ["vmRuntimes_v2/b", {...ws}],
    ["vmRuntimes_v2/foreign", {...ws, ownerUid: "other"}],
    ["vmRuntimes_v2/disabled", {...ws, apiEnabled: false}],
    ["vmRuntimes_v2/legacy", {...ws, backend: "cloud-run"}],
    ["vmRuntimes_v2/a/sessions/s8", session]]);
  const snapshot = path => ({id: path.split("/").pop(), data: () => structuredClone(docs.get(path))});
  const ref = path => ({doc: id => ref(`${path}/${id}`), collection: id => ref(`${path}/${id}`), get: async () => snapshot(path),
    where: (...filter) => query(path, [filter])});
  const queries = [];
  function query(path, filters = [], cursor = "", limit = 100) {
    return {where: (...filter) => query(path, [...filters, filter], cursor, limit),
      orderBy: field => { assert.equal(field, "__name__"); return query(path, filters, cursor, limit); },
      startAfter: next => query(path, filters, next, limit), limit: n => query(path, filters, cursor, n),
      get: async () => {
        queries.push({filters, limit, cursor});
        return {docs: [...docs.keys()].filter(key => key.startsWith(`${path}/`) && key.split("/").length === 2)
            .sort().filter(key => key.split("/").pop() > cursor && filters.every(([field, operator, value]) => {
              assert.equal(operator, "=="); return docs.get(key)[field] === value;
            })).slice(0, limit).map(snapshot)};
      }};
  }
  const db = {collection: ref, runTransaction: fn => fn({get: r => r.get()})};
  return {ws, session, docs, queries, db, service: createVmReadService({db, now: () => 1000})};
}

test("bounded pagination queries only the authenticated owner's admitted VM records", async () => {
  const f = fixture();
  const first = await f.service.list("owner", {limit: "1"});
  assert.deepEqual(first.workspaces.map(ws => ws.id), ["a"]); assert.equal(first.nextCursor, "a");
  const second = await f.service.list("owner", {limit: "1", cursor: first.nextCursor});
  assert.deepEqual(second.workspaces.map(ws => ws.id), ["b"]); assert.equal(second.nextCursor, null);
  assert.equal(f.queries[0].limit, 2);
  assert.deepEqual(f.queries[0].filters, [["ownerUid", "==", "owner"], ["apiEnabled", "==", true], ["backend", "==", "compute-engine"]]);
  assert.ok(!JSON.stringify(first).includes("never-expose"));
  assert.deepEqual((await f.service.list("nobody")).workspaces, []);
  for (const query of [{limit: "0"}, {limit: "101"}, {limit: ["1"]}, {cursor: "../secret"}, {ownerUid: "other"}, null]) {
    await assert.rejects(f.service.list("owner", query), /invalid_vm_page/);
  }
});

test("canonical session projection is generation-consistent, lease-aware and contains no credentials", async () => {
  const f = fixture();
  let result = await f.service.sessions("owner", "a");
  assert.equal(result.sessions[0].status, "running"); assert.equal(result.workspace.canonicalSessionId, "s8");
  assert.ok(!JSON.stringify(result).includes("never-expose"));
  f.session.leaseExpiresAt = 0;
  result = await f.service.sessions("owner", "a");
  assert.equal(result.workspace.ready, false); assert.equal(result.sessions[0].status, "unavailable");
  assert.equal(result.sessions[0].serviceUrl, null);
  f.ws.activeOperationId = "op";
  assert.equal((await f.service.sessions("owner", "a")).sessions[0].status, "provisioning");
  f.ws.state = "stopping";
  assert.equal((await f.service.sessions("owner", "a")).sessions[0].status, "stopping");
  f.ws.state = "stopped";
  assert.equal((await f.service.sessions("owner", "a")).sessions[0].status, "stopped");
  f.session.generation = 7;
  await assert.rejects(f.service.sessions("owner", "a"), /vm_session_mismatch/);
  await assert.rejects(f.service.sessions("other", "a"), /not_found/);
  await assert.rejects(f.service.sessions("owner", "disabled"), /not_found/);
});

test("HTTP discovery authenticates before listing and ignores caller owner selection", async () => {
  const f = fixture();
  const api = createVmApiService({db: f.db, now: () => 1000, requireUser: async req => {
    if (!req.uid) throw new Error("invalid_auth_token"); return {uid: req.uid};
  }});
  await assert.rejects(api({path: "/workspaces", method: "GET"}), /invalid_auth_token/);
  assert.equal(f.queries.length, 0);
  await assert.rejects(api({path: "/workspaces", method: "GET", uid: "owner", query: {ownerUid: "other"}}), /invalid_vm_page/);
  const result = await api({path: "/workspaces", method: "GET", uid: "owner"});
  assert.deepEqual(result.body.workspaces.map(ws => ws.id), ["a", "b"]);
  assert.equal((await api({path: "/workspaces/a/sessions", method: "GET", uid: "owner"})).body.sessions[0].id, "s8");
});
