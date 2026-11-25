"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createVmLifecycleService, CLAIM_MS, OPERATIONS, RETRY_BACKOFF_BASE_MS, STARTUP_DEADLINE_MS} = require("./vmLifecycle.service");
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
  const resizes = [];
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
    resizeDataDisk: async (descriptor, options) => {
      resizes.push({descriptor, options});
      return {resized: true, sizeGb: options.sizeGb};
    },
    start: async (descriptor, options) => {
      assert.equal(options.allowCreateDisk, false);
      assert.ok(options.env.MAPACHE_VM_CONTROL_TOKEN.length >= 32);
      creates.push({operationId: options.operationId, instanceName: descriptor.instanceName, env: options.env});
      const ws = docs.get("vmRuntimes_v2/workspace");
      Object.assign(ws, {state: "active", bootId: "new-boot", leaseExpiresAt: Number.MAX_SAFE_INTEGER});
      Object.assign(docs.get(`vmRuntimes_v2/workspace/sessions/${ws.currentSessionId}`), {state: "active", bootId: "new-boot", leaseExpiresAt: Number.MAX_SAFE_INTEGER});
      return effect("provision");
    },
  }, quiesce: async () => effect("quiesce", {ok: true}), publishRoute: async () => effect("route"), health: async () => effect("health", ready)};
  const service = createVmLifecycleService(dependencies);
  return {service, dependencies, docs, effects, cloud, creates, resizes,
    advance: () => { time += CLAIM_MS + 1; }, crash: phase => { crashPhase = phase; }, ready: value => { ready = value; },
    request: (overrides = {}) => service.request({workspaceId: "workspace", ownerUid: "owner", requestId: "request", action: "replace", expectedGeneration: 6, ...overrides}),
    op: id => docs.get(`${OPERATIONS}/${id}`), ws: () => docs.get("vmRuntimes_v2/workspace"),
  };
}
async function finish(f, id) {
  for (let i = 0; i < 10 && f.op(id).status === "pending"; i++) await f.service.step(id);
  assert.equal(f.op(id).status, "succeeded");
}

test("replacement resolves only retained selections from current owner-private environment entries", async () => {
  const f = fixture();
  f.docs.get("vmRuntimes_v2/workspace/sessions/old").environmentEntryIds = ["selected"];
  f.docs.set("users/owner/private/environmentKeys/entries/selected", {ownerUid: "owner", name: "MY_API_KEY", value: "new-private-value"});
  f.docs.set("users/owner/private/environmentKeys/entries/other", {ownerUid: "owner", name: "OTHER_API_KEY", value: "unselected-private-value"});
  const {operationId} = await f.request();
  await finish(f, operationId);
  const session = f.docs.get(`vmRuntimes_v2/workspace/sessions/${f.ws().currentSessionId}`);
  assert.deepEqual(session.environmentEntryIds, ["selected"]);
  assert.equal(f.creates[0].env.MY_API_KEY, "new-private-value");
  assert.equal(f.creates[0].env.OTHER_API_KEY, undefined);
  for (const record of [session, f.op(operationId), f.ws()]) assert.ok(!JSON.stringify(record).includes("private-value"));
});

test("deleted selected environment prevents provisioning and retains the operation for recovery", async () => {
  const f = fixture();
  f.docs.get("vmRuntimes_v2/workspace/sessions/old").environmentEntryIds = ["deleted"];
  const {operationId} = await f.request();
  for (let i = 0; i < 3; i++) await f.service.step(operationId);
  await assert.rejects(f.service.step(operationId), /vm_environment_entry_unavailable/);
  assert.equal(f.creates.length, 0);
  assert.equal(f.ws().activeOperationId, operationId);
  assert.equal(f.op(operationId).phase, "provision");
  f.docs.set("users/owner/private/environmentKeys/entries/deleted", {ownerUid: "owner", name: "RESTORED_KEY", value: "restored-value"});
  f.advance();
  await finish(f, operationId);
  assert.equal(f.creates.length, 1);
  assert.equal(f.creates[0].env.RESTORED_KEY, "restored-value");
});

test("stopped machine retains environment references and resolves edited values on the next start", async () => {
  const f = fixture();
  f.docs.get("vmRuntimes_v2/workspace/sessions/old").environmentEntryIds = ["selected"];
  f.docs.set("users/owner/private/environmentKeys/entries/selected", {ownerUid: "owner", name: "MY_API_KEY", value: "before-pause"});
  const pause = await f.request({action: "pause"});
  await finish(f, pause.operationId);
  assert.equal(f.creates.length, 0);
  f.docs.get("users/owner/private/environmentKeys/entries/selected").value = "edited-while-stopped";
  const start = await f.request({action: "start", requestId: "next-start"});
  await finish(f, start.operationId);
  assert.equal(f.creates[0].env.MY_API_KEY, "edited-while-stopped");
});

test("desired machine selections override old-session selections and become applied only after health", async () => {
  const f = fixture();
  f.ws().machineConfig = {desiredVersion: 3, appliedVersion: 2, state: "pending-restart",
    desired: {authSelection: {harness: "pi", providers: {}}, environmentEntryIds: ["selected"]}};
  f.docs.get("vmRuntimes_v2/workspace/sessions/old").environmentEntryIds = ["obsolete"];
  f.docs.set("users/owner/private/environmentKeys/entries/selected", {ownerUid: "owner", name: "KEY", value: "current-value"});
  const {operationId} = await f.request();
  for (let i = 0; i < 5; i++) await f.service.step(operationId);
  assert.equal(f.ws().machineConfig.appliedVersion, 2);
  assert.equal(f.op(operationId).phase, "health");
  const session = f.docs.get(`vmRuntimes_v2/workspace/sessions/${f.ws().currentSessionId}`);
  assert.equal(session.configVersion, 3);
  assert.deepEqual(session.environmentEntryIds, ["selected"]);
  assert.equal(f.creates[0].env.KEY, "current-value");
  // Even a newer backend edit cannot be overwritten by this older completion.
  f.ws().machineConfig.desiredVersion = 4;
  f.ws().machineConfig.desired.environmentEntryIds = [];
  await finish(f, operationId);
  assert.equal(f.ws().machineConfig.appliedVersion, 3);
  assert.equal(f.ws().machineConfig.desiredVersion, 4);
  assert.equal(f.ws().machineConfig.state, "pending-restart");
  assert.deepEqual(f.ws().machineConfig.desired.environmentEntryIds, []);
});

test("desired data-disk growth runs after pause and before replacement start", async () => {
  const f = fixture();
  f.ws().machineConfig = {desiredVersion: 3, appliedVersion: 2, state: "pending-restart",
    desired: {diskSizeGb: 128}};
  const {operationId} = await f.request();
  await finish(f, operationId);
  assert.equal(f.resizes.length, 1);
  assert.equal(f.resizes[0].descriptor.generation, 7);
  assert.deepEqual(f.resizes[0].options, {sizeGb: 128, operationId: `${operationId}-resize`, timeoutMs: 240000});
  assert.deepEqual(f.effects, ["quiesce", "delete", "provision", "route", "health"]);
  assert.equal(f.creates.length, 1);
});

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

test("lifecycle receipts retain bounded phase timings and failed phase evidence", async () => {
  const f = fixture();
  const {operationId} = await f.request();
  while (f.op(operationId).phase !== "provision") await f.service.step(operationId);
  f.dependencies.compute.start = async () => {
    const error = new Error("runner_image_rejected");
    error.code = "runner_image_rejected";
    throw error;
  };
  await assert.rejects(f.service.step(operationId), /runner_image_rejected/);
  const operation = f.op(operationId);
  assert.equal(operation.failedPhase, "provision");
  assert.equal(operation.lastError, "runner_image_rejected");
  assert.equal(operation.lastErrorAtMs, 1000);
  assert.deepEqual(operation.phaseTimingsMs, {quiesce: 0, delete: 0, reserve: 0});
});

test("transient quota or attachment failures back off without releasing writer admission", async () => {
  const f = fixture();
  const {operationId} = await f.request();
  await f.service.step(operationId);
  let failed = true;
  const originalPause = f.dependencies.compute.pause;
  f.dependencies.compute.pause = async () => {
    if (failed) {
      const error = new Error("retained disk is still attached");
      error.code = "runtime_data_disk_attached";
      throw error;
    }
    return originalPause();
  };

  await assert.rejects(f.service.step(operationId), /retained disk is still attached/);
  const operation = f.op(operationId);
  assert.equal(operation.failedPhase, "delete");
  assert.equal(operation.phaseAttempts.delete, 1);
  assert.equal(operation.nextAttemptAtMs, 1000 + RETRY_BACKOFF_BASE_MS);
  assert.equal(f.ws().activeOperationId, operationId);
  assert.deepEqual(await f.service.step(operationId), {claimed: false});

  failed = false;
  f.advance();
  await finish(f, operationId);
  assert.equal(f.op(operationId).status, "succeeded");
  assert.equal(f.ws().activeOperationId, null);
});

test("successful lifecycle receipts record every completed phase", async () => {
  const f = fixture();
  const {operationId} = await f.request();
  await finish(f, operationId);
  assert.deepEqual(Object.keys(f.op(operationId).phaseTimingsMs).sort(),
    ["delete", "health", "provision", "quiesce", "reserve", "route"]);
  assert.equal(f.op(operationId).lastError, null);
  assert.equal(f.op(operationId).lastErrorAtMs, null);
});

test("unadmitted and stale machine requests do not create operations", async () => {
  const f = fixture(); f.ws().lifecycleEnabled = false;
  await assert.rejects(f.request(), /vm_lifecycle_not_admitted/);
  f.ws().lifecycleEnabled = true;
  await assert.rejects(f.request({expectedGeneration: 5}), /vm_generation_mismatch/);
  assert.equal(f.docs.size, 2);
  assert.equal(f.effects.length, 0);
  await assert.rejects(f.request({requireApiAdmission: true}), /not_found/);
  assert.equal(f.docs.size, 2);
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

test("startup deadline fails closed and an operator retry reuses the same operation", async () => {
  const f = fixture(); f.ready(false);
  const {operationId} = await f.request();
  while (f.op(operationId).phase !== "health") await f.service.step(operationId);
  assert.equal(f.op(operationId).startupDeadlineAtMs, 1000 + STARTUP_DEADLINE_MS);
  f.advance();
  f.advance();
  const deadline = await f.service.step(operationId);
  assert.deepEqual(deadline, {claimed: false, failed: true, reason: "vm_startup_deadline_exceeded"});
  assert.equal(f.op(operationId).status, "failed");
  assert.equal(f.op(operationId).phase, "failed");
  assert.equal(f.op(operationId).failedPhase, "health");
  assert.equal(f.op(operationId).lastError, "vm_startup_deadline_exceeded");
  assert.equal(f.ws().activeOperationId, operationId);
  await assert.rejects(
      f.service.retry({workspaceId: "workspace", ownerUid: "foreign", operationId}),
      /not_found/,
  );
  const retried = await f.service.retry({workspaceId: "workspace", ownerUid: "owner", operationId});
  assert.deepEqual(retried, {operationId, status: "pending", phase: "health"});
  assert.equal(f.op(operationId).retryCount, 1);
  f.ready(true);
  await finish(f, operationId);
  assert.equal(f.op(operationId).status, "succeeded");
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

test("pause records one VM runtime and retained-storage interval in the user ledger", async () => {
  const f = fixture();
  Object.assign(f.ws(), {createdAtMs: 500, retainedStorageAccruedAtMs: 500, retainedDiskSizeGb: 64});
  Object.assign(f.docs.get("vmRuntimes_v2/workspace/sessions/old"), {runtimeStartedAt: 900});
  const {operationId} = await f.request({action: "pause"});
  await finish(f, operationId);

  const usage = f.docs.get(`users/owner/sessionUsage/vm-workspace-${operationId}`);
  assert.equal(usage.runtimeSeconds, 0.1);
  assert.equal(usage.vmRuntimeSeconds, 0.1);
  assert.equal(usage.retainedStorageGbSeconds, 32);
  assert.equal(f.ws().retainedStorageAccruedAtMs, 1000);
  assert.equal(f.docs.get("vmRuntimes_v2/workspace/sessions/old").usageAccountedAt, 1000);
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
