"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRemoteVmLifecycleService} = require("./remoteVmLifecycle.service");
const {guestConfigurationId} = require("./remoteVmGuestConfig.helpers");
const {createRuntimeDescriptor, REMOTE_LIBVIRT_BACKEND} = require("./runtimeProvider.helpers");
const {AGENT_UI_VERSION} = require("./agentRuntime.helpers");

class Snapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this._value = value;
    this.exists = value !== undefined;
  }

  data() { return this._value; }
}

class Ref {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }

  async get() { return new Snapshot(this, this.db.values.get(this.path)); }
  async set(value, options = {}) {
    const current = this.db.values.get(this.path) || {};
    this.db.values.set(this.path, options.merge ? {...current, ...value} : {...value});
  }
  async update(value) { return this.set(value, {merge: true}); }
  async delete() { this.db.values.delete(this.path); }
  collection(name) { return new Collection(this.db, `${this.path}/${name}`); }
}

class Collection {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return new Ref(this.db, `${this.path}/${id}`, id); }
  where(field, operator, value) {
    return {get: async () => {
      const prefix = `${this.path}/`;
      const docs = [...this.db.values.entries()]
          .filter(([path, data]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && operator === "==" && data?.[field] === value)
          .map(([path, data]) => new Snapshot(new Ref(this.db, path, path.slice(prefix.length)), data));
      return {docs, size: docs.length};
    }};
  }
}

class Db {
  constructor() { this.values = new Map(); this.lock = Promise.resolve(); }
  collection(name) { return new Collection(this, name); }
  runTransaction(callback) {
    let wrote = false;
    const next = this.lock.then(() => callback({
      get: (ref) => { assert.equal(wrote, false, "Firestore reads must precede writes"); return ref.get(); },
      set: (ref, value, options) => { wrote = true; return ref.set(value, options); },
      update: (ref, value) => { wrote = true; return ref.update(value); },
      delete: (ref) => { wrote = true; return ref.delete(); },
    }));
    this.lock = next.catch(() => undefined);
    return next;
  }
}

function fixture() {
  const db = new Db();
  const descriptor = createRuntimeDescriptor({
    backend: REMOTE_LIBVIRT_BACKEND,
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    hostId: "host-1",
  });
  const workspace = {id: "workspace-1", name: "Tower3-personal", ownerUid: "owner-1", runtimeProvider: descriptor};
  const session = {workspaceId: "workspace-1", ownerUid: "owner-1", runtimeProvider: descriptor, status: "provisioning",
    browserAccessTokenSecret: "a".repeat(64), shutdownToken: "b".repeat(48)};
  const host = {
    ownerUid: "owner-1", hostId: "host-1", status: "ready", ready: true,
    capacity: {cpuCount: 8, memoryBytes: 32 * 1024 ** 3, freeDiskBytes: 200 * 1024 ** 3},
  };
  const privateKey = {ownerUid: "owner-1", privateKey: "test-private-key"};
  return {db, descriptor, workspace, session, host, privateKey};
}

async function seed(fixtureValue) {
  const {db, workspace, host, privateKey} = fixtureValue;
  await db.collection("workspaces").doc(workspace.id).set(workspace);
  await db.collection("workspaces").doc(workspace.id).collection("sessions").doc("session-1").set(fixtureValue.session);
  await db.collection("remoteHosts").doc(host.hostId).set(host);
  await db.collection("users").doc("owner-1").collection("private").doc("remoteHosts")
      .collection("entries").doc("host-1").set(privateKey);
}

function fakeHost(behavior = {}, supportsWorkspaceHostname) {
  const guests = new Map();
  const calls = [];
  const operation = async ({action, guest, configuration}) => {
    calls.push(action);
    if (behavior[action]) return behavior[action]({action, guest, guests, calls});
    const current = guests.get(guest.guestName) || {exists: false, state: "stopped"};
    if (action === "inspect") return {...current, supportsWorkspaceHostname, guestName: guest.guestName, diskName: guest.diskName};
    if (action === "create") {
      guests.set(guest.guestName, {exists: true, state: "stopped"});
      return {exists: true, state: "stopped", supportsWorkspaceHostname, guestName: guest.guestName, diskName: guest.diskName};
    }
    if (action === "start") {
      guests.set(guest.guestName, {...current, exists: true, state: "running", guestIp: "192.168.250.42"});
      return {...guests.get(guest.guestName), guestName: guest.guestName, diskName: guest.diskName};
    }
    if (action === "configure") {
      assert.equal(current.state, "stopped");
      guests.set(guest.guestName, {...current, hostname: configuration.WORKSPACE_HOSTNAME, configurationId: guestConfigurationId(configuration)});
      return {...guests.get(guest.guestName), guestName: guest.guestName, diskName: guest.diskName};
    }
    if (action === "stop") {
      guests.set(guest.guestName, {...current, exists: true, state: "stopped"});
      return {...guests.get(guest.guestName), guestName: guest.guestName, diskName: guest.diskName};
    }
    if (action === "destroy") {
      guests.delete(guest.guestName);
      return {exists: false, state: "stopped", guestName: guest.guestName, diskName: guest.diskName};
    }
    throw new Error(`unexpected host action ${action}`);
  };
  return {operation, guests, calls};
}

test("duplicate start requests converge on one retained guest and reservation", async () => {
  const fixtureValue = fixture();
  await seed(fixtureValue);
  const host = fakeHost();
  const service = createRemoteVmLifecycleService({db: fixtureValue.db, hostOperation: host.operation, now: () => "2026-11-25T21:00:00.000Z"});
  const first = await service.start(fixtureValue.workspace, {id: "session-1"}, fixtureValue.session, {idempotencyKey: "start-1"});
  const second = await service.start(fixtureValue.workspace, {id: "session-1"}, fixtureValue.session, {idempotencyKey: "start-1"});
  assert.equal(first.state, "completed");
  assert.equal(second.state, "completed");
  assert.equal(host.guests.get(fixtureValue.descriptor.guestName).state, "running");
  assert.equal(host.guests.get(fixtureValue.descriptor.guestName).hostname, undefined);
  assert.equal(host.calls.filter((action) => action === "start").length, 1);
  assert.equal(host.calls.filter((action) => action === "create").length, 1);
  assert.deepEqual(host.calls.slice(0, 4), ["inspect", "create", "configure", "start"]);
  const savedSession = (await fixtureValue.db.collection("workspaces").doc("workspace-1").collection("sessions").doc("session-1").get()).data();
  assert.equal(savedSession.agentRuntimeBootInstanceId, first.bootId);
  const savedOperation = (await fixtureValue.db.collection("remoteVmOperations").doc(first.id).get()).data();
  assert.equal(JSON.stringify(savedOperation).includes(fixtureValue.session.browserAccessTokenSecret), false);
  const savedHost = (await fixtureValue.db.collection("remoteHosts").doc("host-1").get()).data();
  assert.equal(savedHost.remoteVmReservations.entries.length, 1);
});

test("concurrent provisioning defers to the active lease and adopts completion without another boot", async () => {
  const value = fixture();
  await seed(value);
  const host = fakeHost();
  let releaseStart;
  let signalStart;
  const starting = new Promise((resolve) => { signalStart = resolve; });
  const gate = new Promise((resolve) => { releaseStart = resolve; });
  const service = createRemoteVmLifecycleService({db: value.db, hostOperation: async (request) => {
    if (request.action === "start") {
      signalStart();
      await gate;
    }
    return host.operation(request);
  }});
  const ref = value.db.collection("workspaces").doc("workspace-1").collection("sessions").doc("session-1");
  // A separate worker owns the operation, without the provisioning wrapper.
  const owner = service.start(value.workspace, ref, value.session);
  await starting;
  try {
    await assert.rejects(service.provisionSessionService(value.workspace, ref, value.session),
        (error) => error.code === "remote_vm_provisioning_pending");
    assert.equal((await ref.get()).data().status, "provisioning");
  } finally {
    releaseStart();
  }
  await owner;
  const adopted = await service.provisionSessionService(value.workspace, ref, value.session);
  assert.equal(adopted.status, "running");
  assert.equal((await ref.get()).data().runtimeProvider.guestIp, "192.168.250.42");
  assert.equal(host.calls.filter((action) => action === "create").length, 1);
  assert.equal(host.calls.filter((action) => action === "start").length, 1);
  const savedHost = (await value.db.collection("remoteHosts").doc("host-1").get()).data();
  assert.equal(savedHost.remoteVmReservations.entries.length, 1);
});

test("provisioning completion publishes the gateway and runtime-ready state", async () => {
  const value = fixture();
  value.workspace = {
    ...value.workspace,
    agentUiVersion: AGENT_UI_VERSION,
    agentRuntimeSessionId: "session-1",
    agentRuntimeGeneration: 1,
    agentRuntimeState: "starting",
  };
  value.session = {
    ...value.session,
    agentUiVersion: AGENT_UI_VERSION,
    agentRuntimeGeneration: 1,
    provisioningOperationId: "provision-1",
  };
  await seed(value);
  const host = fakeHost();
  const originalGatewayHosts = process.env.VM_WORKSPACE_GATEWAY_HOSTS;
  process.env.VM_WORKSPACE_GATEWAY_HOSTS =
    "backup-recovery---gateway.example,gateway.example";
  try {
    const service = createRemoteVmLifecycleService({
      db: value.db,
      hostOperation: host.operation,
      now: () => "2026-11-25T21:00:00.000Z",
      markChromeWorkspaceSessionRunning: async (sessionRef, session) => {
        await value.db.collection("workspaces").doc(session.workspaceId).update({
          agentRuntimeState: "running",
          markedSessionId: sessionRef.id,
        });
      },
    });
    const ref = value.db.collection("workspaces").doc("workspace-1")
        .collection("sessions").doc("session-1");
    const completed = await service.provisionSessionService(value.workspace, ref, value.session);
    assert.equal(completed.status, "running");
    assert.equal(completed.serviceUrl, "https://gateway.example");
    assert.equal(completed.provisioningState, "completed");
    assert.equal(completed.agentRuntimeState, "running");
    const savedSession = (await ref.get()).data();
    assert.equal(savedSession.serviceUrl, "https://gateway.example");
    assert.equal(savedSession.provisioningState, "completed");
    assert.equal(savedSession.agentRuntimeState, "running");
    assert.equal((await value.db.collection("workspaces").doc("workspace-1").get()).data().agentRuntimeState, "running");
  } finally {
    if (originalGatewayHosts === undefined) delete process.env.VM_WORKSPACE_GATEWAY_HOSTS;
    else process.env.VM_WORKSPACE_GATEWAY_HOSTS = originalGatewayHosts;
  }
});

test("wrong-owner session cannot configure a guest", async () => {
  const fixtureValue = fixture();
  await seed(fixtureValue);
  await fixtureValue.db.collection("workspaces").doc("workspace-1").collection("sessions").doc("session-1").update({ownerUid: "another-owner"});
  const host = fakeHost();
  const service = createRemoteVmLifecycleService({db: fixtureValue.db, hostOperation: host.operation});
  await assert.rejects(service.start(fixtureValue.workspace, {id: "session-1"}, fixtureValue.session, {idempotencyKey: "wrong-session"}), /remote_vm_session_invalid/);
  assert.deepEqual(host.calls, []);
  const workspace = (await fixtureValue.db.collection("workspaces").doc("workspace-1").get()).data();
  assert.equal(workspace.runtimeProviderState, "error");
});

test("stop releases capacity and resume starts the same guest and disk", async () => {
  const fixtureValue = fixture();
  fixtureValue.session.status = "running";
  await seed(fixtureValue);
  const host = fakeHost({}, true);
  const service = createRemoteVmLifecycleService({db: fixtureValue.db, hostOperation: host.operation});
  await service.start(fixtureValue.workspace, {id: "session-1"}, fixtureValue.session, {idempotencyKey: "start-1"});
  assert.equal(host.guests.get(fixtureValue.descriptor.guestName).hostname, "tower3-personal");
  const stopped = await service.stop({id: "session-1"}, fixtureValue.session, {idempotencyKey: "stop-1"});
  const stoppedSession = (await fixtureValue.db.collection("workspaces").doc("workspace-1")
      .collection("sessions").doc("session-1").get()).data();
  assert.equal(stoppedSession.status, "stopped");
  assert.equal(stoppedSession.runtimeProvider.state, "stopped");
  assert.equal(stoppedSession.serviceUrl, null);
  assert.equal((await fixtureValue.db.collection("remoteHosts").doc("host-1").get()).data().remoteVmReservations.entries.length, 0);
  await fixtureValue.db.collection("workspaces").doc("workspace-1").update({name: "Renamed workspace"});
  const resumed = await service.start(fixtureValue.workspace, {id: "session-1"}, fixtureValue.session, {idempotencyKey: "start-2"});
  assert.equal(host.guests.get(fixtureValue.descriptor.guestName).hostname, "renamed-workspace");
  assert.equal(stopped.state, "completed");
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.guestName, fixtureValue.descriptor.guestName);
  assert.equal(resumed.diskName, fixtureValue.descriptor.dataDiskName);
  const savedHost = (await fixtureValue.db.collection("remoteHosts").doc("host-1").get()).data();
  assert.equal(savedHost.remoteVmReservations.entries.length, 1);
  assert.equal(host.guests.size, 1);
});

test("automatic reconciliation leaves permanent failures for explicit retry", async () => {
  const fixtureValue = fixture();
  await seed(fixtureValue);
  const host = fakeHost();
  const service = createRemoteVmLifecycleService({db: fixtureValue.db, hostOperation: host.operation});
  const started = await service.start(fixtureValue.workspace, {id: "session-1"}, fixtureValue.session, {idempotencyKey: "start-1"});
  await fixtureValue.db.collection("remoteVmOperations").doc(started.id).update({state: "error", retryable: false});
  host.calls.length = 0;
  assert.equal((await service.reconcileOperation(started.id, {retryFailed: false})).state, "error");
  assert.deepEqual(host.calls, []);
  assert.equal((await service.reconcileOperation(started.id)).state, "completed");
});

test("cancelling a start for a deleted workspace releases capacity before transaction writes", async () => {
  const value = fixture();
  await seed(value);
  const host = fakeHost();
  const service = createRemoteVmLifecycleService({db: value.db, hostOperation: async (request) => {
    const result = await host.operation(request);
    if (request.action === "start") await value.db.collection("workspaces").doc("workspace-1").update({deleted: true});
    return result;
  }});
  const result = await service.start(value.workspace, {id: "session-1"}, value.session);
  assert.equal(result.state, "cancelled");
  assert.equal((await value.db.collection("remoteHosts").doc("host-1").get()).data().remoteVmReservations.entries.length, 0);
});

test("capacity admission is serialized across workspaces", async () => {
  const first = fixture();
  const second = fixture();
  second.workspace.id = "workspace-2";
  second.session = {...second.session, workspaceId: "workspace-2"};
  second.descriptor = createRuntimeDescriptor({backend: REMOTE_LIBVIRT_BACKEND, workspaceId: "workspace-2", ownerUid: "owner-1", hostId: "host-1"});
  second.workspace.runtimeProvider = second.descriptor;
  second.session.runtimeProvider = second.descriptor;
  second.host.capacity = {cpuCount: 4, memoryBytes: 20 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3};
  await seed(first);
  await first.db.collection("workspaces").doc("workspace-2").set(second.workspace);
  const hostRef = first.db.collection("remoteHosts").doc("host-1");
  await hostRef.set(second.host);
  const privateRef = first.db.collection("users").doc("owner-1").collection("private").doc("remoteHosts").collection("entries").doc("host-1");
  await privateRef.set(second.privateKey);
  const remote = fakeHost();
  const service = createRemoteVmLifecycleService({db: first.db, hostOperation: remote.operation});
  const results = await Promise.allSettled([
    service.start(first.workspace, {id: "session-1"}, first.session, {idempotencyKey: "one"}),
    service.start(second.workspace, {id: "session-2"}, second.session, {idempotencyKey: "two"}),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(String(rejected?.reason?.publicMessage || rejected?.reason?.message), /remote_vm_capacity_exhausted/);
});

test("lost SSH response reconciles by inspecting the owned guest", async () => {
  const fixtureValue = fixture();
  await seed(fixtureValue);
  let lost = true;
  const host = fakeHost({
    start: ({guest, guests}) => {
      guests.set(guest.guestName, {...guests.get(guest.guestName), exists: true, state: "running", guestIp: "192.168.250.42"});
      if (lost) {
        lost = false;
        const error = new Error("response lost");
        error.code = "remote_vm_response_lost";
        throw error;
      }
      return {...guests.get(guest.guestName), guestName: guest.guestName, diskName: guest.diskName};
    },
  });
  const service = createRemoteVmLifecycleService({db: fixtureValue.db, hostOperation: host.operation});
  const result = await service.start(fixtureValue.workspace, {id: "session-1"}, fixtureValue.session, {idempotencyKey: "lost"});
  assert.equal(result.state, "completed");
  assert.equal(host.calls.filter((action) => action === "start").length, 1);
  assert.ok(host.calls.includes("inspect"));
});

test("offline deletion remains pending and reconciles without deleting the workspace early", async () => {
  const fixtureValue = fixture();
  await seed(fixtureValue);
  const host = fakeHost();
  const service = createRemoteVmLifecycleService({db: fixtureValue.db, hostOperation: host.operation});
  await service.start(fixtureValue.workspace, {id: "session-1"}, fixtureValue.session, {idempotencyKey: "start"});
  let offline = true;
  const original = host.operation;
  const operation = async (request) => {
    if (offline && request.action === "inspect") {
      const error = new Error("offline");
      error.code = "remote_host_unreachable";
      throw error;
    }
    return original(request);
  };
  const pending = await createRemoteVmLifecycleService({db: fixtureValue.db, hostOperation: operation})
      .delete({id: "session-1"}, fixtureValue.session, {deleteWorkspace: true, idempotencyKey: "delete"});
  assert.equal(pending.state, "unreachable");
  assert.equal((await fixtureValue.db.collection("workspaces").doc("workspace-1").get()).data().deleted, undefined);
  offline = false;
  const reconciled = await createRemoteVmLifecycleService({db: fixtureValue.db, hostOperation: operation})
      .reconcileOperation(pending.id);
  assert.equal(reconciled.state, "completed");
  assert.equal((await fixtureValue.db.collection("workspaces").doc("workspace-1").get()).data().deleted, true);
  assert.equal(host.guests.size, 0);
});

test("owner and managed guest fences reject foreign identifiers", async () => {
  const fixtureValue = fixture();
  await seed(fixtureValue);
  const service = createRemoteVmLifecycleService({db: fixtureValue.db, hostOperation: async ({action, guest}) => {
    if (action === "inspect") return {exists: true, state: "running", guestName: "mapache-ws-foreign", diskName: guest.diskName};
    return {exists: true, state: "running", guestName: guest.guestName, diskName: guest.diskName};
  }});
  const foreignSession = {
    ...fixtureValue.session,
    ownerUid: "owner-2",
    runtimeProvider: createRuntimeDescriptor({
      backend: REMOTE_LIBVIRT_BACKEND,
      workspaceId: "workspace-1",
      ownerUid: "owner-2",
      hostId: "host-1",
    }),
  };
  await assert.rejects(() => service.start(fixtureValue.workspace, {id: "session-1"}, foreignSession), /workspace_forbidden/);
  await assert.rejects(() => service.start(fixtureValue.workspace, {id: "session-1"}, fixtureValue.session, {idempotencyKey: "foreign-guest"}), /remote_vm_foreign_guest/);
});
