"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createVmCreationService} = require("./vmCreation.service");
const {createVmLifecycleService, CLAIM_MS} = require("./vmLifecycle.service");
const {createVmApiService} = require("./vmApi.service");

function fixture() {
  let time = 1000; let serial = Promise.resolve();
  const docs = new Map([["vmCreationAdmissions_v2/new", {ownerUid: "owner", enabled: true,
    gatewayHost: "new.example.com", runnerImage: `us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:${"a".repeat(64)}`}]]);
  const ref = path => ({path, collection: key => ref(`${path}/${key}`), doc: key => ref(`${path}/${key}`), get: async () => snap(path)});
  const snap = path => ({exists: docs.has(path), data: () => structuredClone(docs.get(path))});
  const db = {doc: ref, collection: ref, runTransaction(fn) {
    const result = serial.then(async () => {
      const changes = [];
      const value = await fn({get: async r => snap(r.path), set: (r, data) => changes.push(() => docs.set(r.path, structuredClone(data))),
        update: (r, data) => changes.push(() => docs.set(r.path, {...docs.get(r.path), ...structuredClone(data)}))});
      changes.forEach(fn => fn()); return value;
    });
    serial = result.catch(() => {}); return result;
  }};
  const create = createVmCreationService({db, now: () => time});
  return {docs, db, now: () => time, advance: () => { time += CLAIM_MS + 1; },
    create: (override = {}) => create({workspaceId: "new", ownerUid: "owner", requestId: "first", name: "New machine", ...override})};
}

test("creation atomically reserves one workspace, origin, credentials and operation; duplicates reuse them", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.create(), f.create()]);
  assert.deepEqual(a, b);
  assert.equal(f.docs.size, 6);
  const ws = f.docs.get("vmRuntimes_v2/new");
  assert.equal(ws.activeOperationId, a.operationId);
  const secret = structuredClone(f.docs.get(`vmRuntimeCredentials_v2/${ws.currentSessionId}`));
  await assert.rejects(f.create({requestId: "competing"}), /vm_workspace_already_exists/);
  await assert.rejects(f.create({name: "changed"}), /vm_request_id_conflict/);
  await assert.rejects(f.create({ownerUid: "foreign"}), /not_found/);
  assert.deepEqual(f.docs.get(`vmRuntimeCredentials_v2/${ws.currentSessionId}`), secret);
  f.docs.get("vmCreationAdmissions_v2/new").enabled = false;
  await assert.rejects(f.create(), /not_found/);
});

test("creation refuses legacy workspaces, occupied origins and invalid backend admissions without partial writes", async () => {
  for (const change of [f => f.docs.set("workspaces/new", {ownerUid: "owner"}),
    f => f.docs.set("vmGatewayRoutes_v2/new.example.com", {enabled: false, workspaceId: "other"}),
    f => { f.docs.get("vmCreationAdmissions_v2/new").runnerImage = "untrusted"; },
    f => { f.docs.get("vmCreationAdmissions_v2/new").enabled = false; }]) {
    const f = fixture(); change(f); const before = structuredClone([...f.docs]);
    await assert.rejects(f.create()); assert.deepEqual([...f.docs], before);
  }
});

test("creation API derives the owner from authentication and rejects infrastructure fields", async () => {
  const f = fixture();
  const api = createVmApiService({db: f.db, now: f.now, lifecycle: {}, requireUser: async req => {
    if (!req.uid) throw new Error("invalid_auth_token");
    return {uid: req.uid};
  }});
  const request = {path: "/workspaces/new/create", method: "POST", body: {requestId: "first", name: "New machine"}, uid: "owner"};
  await assert.rejects(api({...request, uid: null}), /invalid_auth_token/);
  await assert.rejects(api({...request, uid: "foreign"}), /not_found/);
  for (const field of ["ownerUid", "runnerImage", "gatewayHost", "allowCreateDisk", "expectedGeneration"]) {
    await assert.rejects(api({...request, body: {...request.body, [field]: "untrusted"}}), /invalid_vm_request/);
  }
  assert.equal(f.docs.size, 1);
  assert.equal((await api(request)).status, 202);
  assert.equal(f.docs.get("vmRuntimes_v2/new").ownerUid, "owner");
});

test("lost initial disk response reconciles once; provisioning never recreates subsequently missing storage", async () => {
  const f = fixture(); const {operationId} = await f.create();
  let disk = false; let diskCalls = 0; let interrupt = true; let starts = 0;
  const op = () => f.docs.get(`vmLifecycleOperations_v2/${operationId}`);
  const worker = () => createVmLifecycleService({db: f.db, now: f.now, compute: {
    ensureDataDisk: async (descriptor, options) => {
      assert.equal(options.allowCreateDisk, true); assert.equal(descriptor.generation, 1);
      diskCalls++; disk = true;
      if (interrupt) { interrupt = false; throw new Error("worker_lost"); }
    }, start: async (descriptor, options) => {
      starts++; assert.equal(options.allowCreateDisk, false); assert.equal(options.allowInitializeDisk, true);
      assert.equal(options.operationId, `${operationId}-create`);
      if (!disk) throw new Error("runtime_data_disk_missing");
      const ws = f.docs.get("vmRuntimes_v2/new");
      const session = f.docs.get(`vmRuntimes_v2/new/sessions/${ws.currentSessionId}`);
      for (const record of [ws, session]) Object.assign(record, {state: "active", bootId: "boot", leaseExpiresAt: Number.MAX_SAFE_INTEGER});
    }, pause: async () => { throw new Error("initial creation must not delete compute"); },
  }, publishRoute: async () => {}, health: async () => true});
  await assert.rejects(worker().step(operationId), /worker_lost/);
  assert.equal(op().phase, "disk");
  assert.deepEqual(await worker().step(operationId), {claimed: false});
  f.advance(); await worker().step(operationId);
  assert.equal(op().phase, "provision"); assert.equal(diskCalls, 2);
  disk = false;
  await assert.rejects(worker().step(operationId), /runtime_data_disk_missing/);
  assert.equal(op().phase, "provision"); assert.equal(diskCalls, 2);
  disk = true; f.advance();
  for (let i = 0; i < 3; i++) await worker().step(operationId);
  assert.equal(op().status, "succeeded"); assert.equal(starts, 2);
  assert.equal(f.docs.get("vmRuntimes_v2/new").lifecycleReadyGeneration, 1);
});

test("a lost provisioning response cannot renew initialization authority after boot admission", async () => {
  const f = fixture(); const {operationId} = await f.create();
  let starts = 0; let disks = 0;
  const service = createVmLifecycleService({db: f.db, now: f.now, compute: {
    ensureDataDisk: async () => { disks++; },
    start: async (descriptor, options) => {
      assert.equal(options.allowCreateDisk, false);
      assert.equal(options.allowInitializeDisk, starts === 0);
      starts++;
      const ws = f.docs.get("vmRuntimes_v2/new");
      for (const r of [ws, f.docs.get(`vmRuntimes_v2/new/sessions/${ws.currentSessionId}`)]) {
        Object.assign(r, {state: "active", bootId: "boot", leaseExpiresAt: Number.MAX_SAFE_INTEGER});
      }
      if (starts === 1) throw new Error("response_lost");
    },
  }, publishRoute: async () => {}, health: async () => true});
  await service.step(operationId);
  await assert.rejects(service.step(operationId), /response_lost/);
  f.advance();
  for (let i = 0; i < 3; i++) await service.step(operationId);
  assert.equal(starts, 2); assert.equal(disks, 1);
  assert.equal(f.docs.get(`vmLifecycleOperations_v2/${operationId}`).status, "succeeded");
});
