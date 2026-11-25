"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createVmApiService} = require("./vmApi.service");

function fixture() {
  const docs = new Map([
    ["vmRuntimes_v2/machine", {ownerUid: "owner", backend: "compute-engine", apiEnabled: true, generation: 2, currentSessionId: "session", state: "stopped"}],
    ["vmRuntimes_v2/machine/sessions/session", {ownerUid: "owner", generation: 2, authSelection: {harness: "pi", providers: {}}, environmentEntryIds: []}],
    ["users/owner/private/environmentKeys/entries/key", {ownerUid: "owner", name: "API_KEY", value: "private-environment-value"}],
    ["users/owner/private/agentAuth", {entries: {selected: {providerKey: "openai", credential: {type: "api_key", key: "private-provider-value"}}}}],
  ]);
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const ref = path => ({path, collection: id => ref(`${path}/${id}`), doc: id => ref(`${path}/${id}`)});
  let serial = Promise.resolve();
  const db = {collection: ref, runTransaction(fn) {
    const result = serial.then(async () => {
      const changes = [];
      const value = await fn({get: async r => ({data: () => clone(docs.get(r.path))}),
        update: (r, data) => changes.push(() => docs.set(r.path, {...docs.get(r.path), ...clone(data)}))});
      changes.forEach(apply => apply()); return value;
    });
    serial = result.catch(() => {}); return result;
  }};
  const service = createVmApiService({db, requireUser: async req => ({uid: req.uid}), lifecycle: {
    request: () => { throw Error("saving configuration must not start compute"); },
  }});
  return {docs, ws: () => docs.get("vmRuntimes_v2/machine"), session: () => docs.get("vmRuntimes_v2/machine/sessions/session"),
    call: (body, uid = "owner") => service({path: "/workspaces/machine/configuration", method: body === undefined ? "GET" : "PATCH", body, uid})};
}

test("stopped machine saves references as pending without changing its session or booting", async () => {
  const f = fixture();
  const before = structuredClone(f.session());
  assert.equal((await f.call()).body.state, "unversioned");
  const result = await f.call({expectedGeneration: 2, expectedVersion: 0,
    authSelection: {harness: "pi", providers: {openai: "selected"}}, environmentEntryIds: ["key"]});
  assert.equal(result.body.desiredVersion, 1);
  assert.equal(result.body.appliedVersion, 0);
  assert.equal(result.body.restartRequired, true);
  assert.equal(result.body.state, "pending-restart");
  assert.equal(f.ws().state, "stopped");
  assert.deepEqual(f.session(), before);
  assert.deepEqual((await f.call()).body, result.body);
  for (const value of [result, f.ws(), f.session()]) assert.ok(!JSON.stringify(value).includes("private-"));
  await f.call({expectedGeneration: 2, expectedVersion: 1, environmentEntryIds: []});
  assert.deepEqual(f.ws().machineConfig.desired.authSelection.providers, {openai: "selected"});
});

test("foreign callers, stale generations, concurrent saves, and active lifecycle operations cannot change configuration", async () => {
  const f = fixture();
  const patch = {expectedGeneration: 2, expectedVersion: 0, environmentEntryIds: []};
  await assert.rejects(f.call(undefined, "other"), /not_found/);
  await assert.rejects(f.call(patch, "other"), /not_found/);
  await assert.rejects(f.call({...patch, expectedGeneration: 1}), /vm_generation_mismatch/);
  const results = await Promise.allSettled([f.call(patch), f.call(patch)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.message, /vm_configuration_version_mismatch/);
  f.ws().activeOperationId = "operation";
  await assert.rejects(f.call({...patch, expectedVersion: 1}), /vm_operation_in_progress/);
  f.ws().apiEnabled = false;
  await assert.rejects(f.call(), /not_found/);
});

test("saving on a running machine leaves the active configuration and applied revision intact", async () => {
  const f = fixture();
  f.ws().state = "active";
  f.ws().machineConfig = {desiredVersion: 2, appliedVersion: 2, state: "applied",
    desired: {authSelection: {harness: "pi", providers: {}}, environmentEntryIds: []}};
  const before = structuredClone(f.session());
  const saved = await f.call({expectedGeneration: 2, expectedVersion: 2, environmentEntryIds: ["key"]});
  assert.equal(saved.body.appliedVersion, 2);
  assert.equal(saved.body.desiredVersion, 3);
  assert.equal(saved.body.state, "pending-restart");
  assert.equal(f.ws().state, "active");
  assert.deepEqual(f.session(), before);
});

test("saves Compute Engine resources and only permits monotonic disk growth", async () => {
  const f = fixture();
  const saved = await f.call({expectedGeneration: 2, expectedVersion: 0,
    resources: {cpu: "2", memory: "4Gi"}, diskSizeGb: 128});
  assert.deepEqual(saved.body.desired.resources, {cpu: "2", memory: "4Gi"});
  assert.equal(saved.body.desired.diskSizeGb, 128);
  await assert.rejects(f.call({expectedGeneration: 2, expectedVersion: 1, diskSizeGb: 64}), /vm_disk_shrink_unsupported/);
  assert.equal(f.ws().machineConfig.desiredVersion, 1);
  assert.equal(f.ws().machineConfig.desired.diskSizeGb, 128);
});

test("metadata and idle policy save without requiring a VM restart", async () => {
  const f = fixture();
  const saved = await f.call({expectedGeneration: 2, expectedVersion: 0,
    description: "Primary machine", idleStopMinutes: 30});
  assert.deepEqual(saved.body.desired, {authSelection: {harness: "pi", providers: {}}, environmentEntryIds: [],
    resources: null, diskSizeGb: null, description: "Primary machine", idleStopMinutes: 30});
  assert.equal(saved.body.appliedVersion, 1);
  assert.equal(saved.body.restartRequired, false);
  assert.equal(saved.body.state, "applied");
});

test("idle policy validation is bounded", async () => {
  const f = fixture();
  for (const value of [4, 1441, "not-a-number"]) {
    await assert.rejects(f.call({expectedGeneration: 2, expectedVersion: 0, idleStopMinutes: value}), /invalid_vm_idle_stop_minutes/);
  }
});

test("strict references reject secrets, infrastructure overrides and missing or mismatched credentials atomically", async () => {
  const f = fixture();
  const patch = {expectedGeneration: 2, expectedVersion: 0, environmentEntryIds: []};
  for (const changes of [{ownerUid: "other"}, {runnerImage: "image"}, {environmentEntryIds: "key"},
    {authSelection: {harness: "pi", providers: {openai: "missing"}}},
    {authSelection: {harness: "pi", providers: {anthropic: "selected"}}},
    {authSelection: {harness: "pi", providers: {openai: {key: "secret"}}}},
    {environmentEntryIds: ["missing"]}, {environmentEntryIds: ["../foreign"]}]) {
    await assert.rejects(f.call({...patch, ...changes}));
    assert.equal(f.ws().machineConfig, undefined);
  }
  f.docs.get("users/owner/private/environmentKeys/entries/key").name = "MAPACHE_VM_CONTROL_TOKEN";
  await assert.rejects(f.call({...patch, environmentEntryIds: ["key"]}), /reserved_vm_environment_name/);
});
