"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createVmLifecycleService, CLAIM_MS, OPERATIONS} = require("./vmLifecycle.service");
const {createRuntimeDescriptor} = require("./runtimeProvider.helpers");

function fixture() {
  let time = 1000;
  let serial = Promise.resolve();
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "workspace", ownerUid: "owner", generation: 6});
  const docs = new Map([
    ["vmRuntimes_v2/workspace", {ownerUid: "owner", backend: "compute-engine", generation: 6, currentSessionId: "old",
      state: "active", lifecycleEnabled: true, runnerImage: `us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:${"a".repeat(64)}`, gatewayHost: "fixture.example.com"}],
    ["vmRuntimes_v2/workspace/sessions/old", {ownerUid: "owner", generation: 6, state: "active", runtimeProvider: descriptor, piScopedModels: ["selected/model"]}],
  ]);
  const copy = value => value === undefined ? undefined : structuredClone(value);
  const snap = path => ({exists: docs.has(path), data: () => copy(docs.get(path))});
  const ref = path => ({path, collection: id => ref(`${path}/${id}`), doc: id => ref(`${path}/${id}`), get: async () => snap(path)});
  const db = {doc: ref, collection: ref, runTransaction(fn) {
    const result = serial.then(async () => {
      const changes = [];
      const value = await fn({get: async r => snap(r.path),
        set: (r, data) => changes.push(() => docs.set(r.path, copy(data))),
        update: (r, data) => changes.push(() => docs.set(r.path, {...docs.get(r.path), ...copy(data)})),
      });
      changes.forEach(apply => apply()); return value;
    });
    serial = result.catch(() => {}); return result;
  }};
  const effects = [];
  const creates = [];
  const cloud = new Set();
  let crashPhase;
  let ready = true;
  async function effect(phase, value) {
    effects.push(phase); cloud.add(phase);
    if (crashPhase === phase) { crashPhase = null; throw new Error("worker_died_after_effect"); }
    return value;
  }
  const dependencies = {db, now: () => time, compute: {
    pause: async () => effect("delete"),
    start: async (descriptor, options) => {
      assert.equal(options.allowCreateDisk, false);
      assert.ok(options.env.MAPACHE_VM_CONTROL_TOKEN.length >= 32);
      creates.push({operationId: options.operationId, instanceName: descriptor.instanceName});
      const ws = docs.get("vmRuntimes_v2/workspace");
      Object.assign(ws, {state: "active", bootId: "new-boot", leaseExpiresAt: Number.MAX_SAFE_INTEGER});
      Object.assign(docs.get(`vmRuntimes_v2/workspace/sessions/${ws.currentSessionId}`), {state: "active", bootId: "new-boot", leaseExpiresAt: Number.MAX_SAFE_INTEGER});
      return effect("provision");
    },
  }, quiesce: async () => effect("quiesce", {ok: true}), publishRoute: async () => effect("route"), health: async () => effect("health", ready)};
  const service = createVmLifecycleService(dependencies);
  return {service, dependencies, docs, effects, cloud, creates,
    advance: () => { time += CLAIM_MS + 1; }, crash: phase => { crashPhase = phase; }, ready: value => { ready = value; },
    request: (overrides = {}) => service.request({workspaceId: "workspace", ownerUid: "owner", requestId: "request", action: "replace", expectedGeneration: 6, ...overrides}),
    op: id => docs.get(`${OPERATIONS}/${id}`), ws: () => docs.get("vmRuntimes_v2/workspace"),
  };
}
async function finish(f, id) {
  for (let i = 0; i < 10 && f.op(id).status === "pending"; i++) await f.service.step(id);
  assert.equal(f.op(id).status, "succeeded");
}

test("duplicate requests share one operation and competing requests cannot acquire the machine", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.request(), f.request()]);
  assert.equal(a.operationId, b.operationId);
  await assert.rejects(f.request({requestId: "other", action: "pause"}), /vm_operation_in_progress/);
  await assert.rejects(f.request({action: "pause"}), /vm_request_id_conflict/);
  await assert.rejects(f.request({ownerUid: "foreign"}), /not_found/);
  await finish(f, a.operationId);
  assert.equal(f.ws().generation, 7);
  assert.equal(f.ws().activeOperationId, null);
  assert.equal(f.ws().lifecycleReadyGeneration, 7);
  assert.deepEqual(f.docs.get(`vmRuntimes_v2/workspace/sessions/${f.ws().currentSessionId}`).piScopedModels, ["selected/model"]);
  assert.deepEqual(f.effects, ["quiesce", "delete", "provision", "route", "health"]);
});

test("unadmitted and stale machine requests do not create operations", async () => {
  const f = fixture(); f.ws().lifecycleEnabled = false;
  await assert.rejects(f.request(), /vm_lifecycle_not_admitted/);
  f.ws().lifecycleEnabled = true;
  await assert.rejects(f.request({expectedGeneration: 5}), /vm_generation_mismatch/);
  assert.equal(f.docs.size, 2);
  assert.equal(f.effects.length, 0);
});

test("each interrupted effect reconciles the same phase without dropping writer admission", async () => {
  for (const phase of ["quiesce", "delete", "provision", "route", "health"]) {
    const f = fixture(); const {operationId} = await f.request();
    while (f.op(operationId).phase !== phase) await f.service.step(operationId);
    f.crash(phase);
    await assert.rejects(f.service.step(operationId), /worker_died_after_effect/);
    assert.equal(f.ws().activeOperationId, operationId);
    assert.equal(f.op(operationId).phase, phase);
    assert.deepEqual(await f.service.step(operationId), {claimed: false});
    await assert.rejects(f.request({requestId: "competing", expectedGeneration: f.ws().generation}), /vm_operation_in_progress/);
    f.advance(); await finish(f, operationId);
    assert.equal(f.ws().generation, 7);
    assert.equal(f.docs.size, 5, "one operation, two sessions and one new secret record plus workspace");
    assert.equal(f.effects.filter(value => value === phase).length, 2);
    assert.equal(new Set(f.creates.map(value => value.operationId)).size, 1);
    assert.equal(new Set(f.creates.map(value => value.instanceName)).size, 1);
  }
});

test("Compute success without healthy agent stays pending and retains the operation", async () => {
  const f = fixture(); f.ready(false);
  const {operationId} = await f.request();
  for (let i = 0; i < 6; i++) await f.service.step(operationId);
  assert.equal(f.op(operationId).phase, "health");
  assert.equal(f.op(operationId).status, "pending");
  assert.equal(f.ws().activeOperationId, operationId);
  assert.equal(f.ws().lifecycleReadyGeneration, undefined);
  f.advance(); f.ready(true); await finish(f, operationId);
});

test("pause confirms deletion before stopped; start then reserves a fresh generation", async () => {
  const f = fixture(); const {operationId} = await f.request({action: "pause"});
  await finish(f, operationId);
  assert.equal(f.ws().state, "stopped");
  assert.equal(f.docs.get("vmRuntimes_v2/workspace/sessions/old").state, "stopped");
  const next = await f.request({action: "start", requestId: "start"});
  await finish(f, next.operationId);
  assert.equal(f.ws().generation, 7);
});

test("stale worker completion cannot overwrite a newer claim", async () => {
  const f = fixture(); const {operationId} = await f.request();
  while (f.op(operationId).phase !== "provision") await f.service.step(operationId);
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const original = f.dependencies.compute.start;
  f.dependencies.compute.start = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const old = f.service.step(operationId);
  await started; f.advance(); f.dependencies.compute.start = original;
  await f.service.step(operationId);
  release(); await assert.rejects(old, /vm_worker_claim_lost/);
  assert.equal(f.op(operationId).phase, "route");
  assert.equal(f.op(operationId).claim, null);
  await finish(f, operationId);
});

test("healthy response cannot complete a generation whose writer lease was lost", async () => {
  const f = fixture(); const {operationId} = await f.request();
  while (f.op(operationId).phase !== "health") await f.service.step(operationId);
  f.ws().leaseExpiresAt = 0;
  await assert.rejects(f.service.step(operationId), /vm_readiness_authority_lost/);
  assert.equal(f.ws().activeOperationId, operationId);
  assert.equal(f.ws().lifecycleReadyGeneration, undefined);
});

test("reservation carries the configuration saved during quiesce rather than an enqueue snapshot", async () => {
  const f = fixture(); const {operationId} = await f.request();
  while (f.op(operationId).phase !== "reserve") await f.service.step(operationId);
  const old = f.docs.get("vmRuntimes_v2/workspace/sessions/old");
  old.piScopedModels = ["saved/at-shutdown"];
  old.authSelection = {harness: "pi", providers: {openai: "selected-entry"}};
  await finish(f, operationId);
  const current = f.docs.get(`vmRuntimes_v2/workspace/sessions/${f.ws().currentSessionId}`);
  assert.deepEqual(current.piScopedModels, old.piScopedModels);
  assert.deepEqual(current.authSelection, old.authSelection);
});
