"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  HOST_STATUS,
  createRemoteHostService,
  generateKeyMaterial,
  normalizeHostAddress,
} = require("./remoteHost.service");

class FakeSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this._value = value;
    this.exists = value !== undefined;
  }

  data() {
    return this._value;
  }
}

class FakeQuery {
  constructor(collection, filters = []) {
    this.collection = collection;
    this.filters = filters;
  }

  where(field, operator, value) {
    return new FakeQuery(this.collection, [...this.filters, {field, operator, value}]);
  }

  async get() {
    const docs = [...this.collection.values.values()]
        .map((value, id) => new FakeSnapshot(this.collection.ref(id), value))
        .filter((doc) => this.filters.every(({field, operator, value}) => operator === "==" && doc.data()?.[field] === value));
    return {docs, size: docs.length};
  }
}

class FakeCollection {
  constructor(store, path) {
    this.store = store;
    this.path = path;
    this.values = store.collections.get(path) || new Map();
    store.collections.set(path, this.values);
  }

  doc(id = `auto-${this.values.size + 1}`) {
    return this.ref(id);
  }

  ref(id) {
    return new FakeRef(this.store, this.path, id, this.values);
  }

  where(field, operator, value) {
    return new FakeQuery(this, [{field, operator, value}]);
  }

  async get() {
    return new FakeQuery(this).get();
  }
}

class FakeRef {
  constructor(store, collectionPath, id, values) {
    this.store = store;
    this.collectionPath = collectionPath;
    this.id = id;
    this.values = values;
    this.path = `${collectionPath}/${id}`;
  }

  async get() {
    return new FakeSnapshot(this, this.values.get(this.id));
  }

  async set(value, options = {}) {
    const current = this.values.get(this.id) || {};
    this.values.set(this.id, options.merge ? {...current, ...value} : {...value});
  }

  async delete() {
    this.values.delete(this.id);
  }

  collection(name) {
    return new FakeCollection(this.store, `${this.path}/${name}`);
  }
}

class FakeDb {
  constructor() {
    this.collections = new Map();
    this.lock = Promise.resolve();
  }

  collection(name) {
    return new FakeCollection(this, name);
  }

  async runTransaction(callback) {
    const run = this.lock.then(() => callback({
      get: (refOrQuery) => refOrQuery.get(),
      set: (ref, value, options) => ref.set(value, options),
      delete: (ref) => ref.delete(),
    }));
    this.lock = run.catch(() => undefined);
    return run;
  }
}

function dependencies(overrides = {}) {
  return {
    db: new FakeDb(),
    now: () => "2026-11-25T21:00:00.000Z",
    createHostId: () => "test-host",
    generateKeyMaterial: () => ({
      privateKey: "PRIVATE-KEY",
      publicKey: "ssh-ed25519 AAAATEST mapache-remote-host",
      publicKeyFingerprint: "SHA256/public-key",
    }),
    ...overrides,
  };
}

test("generates an OpenSSH public key and never exposes the private key", () => {
  const material = generateKeyMaterial();
  assert.match(material.privateKey, /BEGIN PRIVATE KEY/);
  assert.match(material.publicKey, /^ssh-ed25519 /);
  assert.match(material.publicKeyFingerprint, /^SHA256\//);
});

test("registers owner-scoped host metadata and stores key material privately", async () => {
  const deps = dependencies();
  const service = createRemoteHostService(deps);
  const host = await service.registerRemoteHost("owner-a", {
    displayName: "Home",
    address: "home.example.com",
    username: "mapache",
  });
  assert.equal(host.status, HOST_STATUS.PENDING_SETUP);
  assert.equal(host.appPublicKey, "ssh-ed25519 AAAATEST mapache-remote-host");
  assert.equal(JSON.stringify(host).includes("PRIVATE-KEY"), false);
  const privateDoc = await deps.db.collection("users").doc("owner-a").collection("private")
      .doc("remoteHosts").collection("entries").doc(host.hostId).get();
  assert.equal(privateDoc.data().privateKey, "PRIVATE-KEY");
  assert.deepEqual((await service.listRemoteHosts("owner-b")).hosts, []);
  await assert.rejects(() => service.getRemoteHost("owner-b", host.hostId), /remote_host_not_found/);
});

test("serializes concurrent registration so one owner gets one active host", async () => {
  const deps = dependencies();
  const service = createRemoteHostService(deps);
  const results = await Promise.allSettled([
    service.registerRemoteHost("owner-a", {displayName: "One", address: "one.example.com"}),
    service.registerRemoteHost("owner-a", {displayName: "Two", address: "two.example.com"}),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected")[0].reason.publicMessage, "remote_host_limit_reached");
});

test("requires explicit host-key confirmation and rejects changed fingerprints", async () => {
  const deps = dependencies({
    resolveHost: async () => [{address: "203.0.113.5"}],
    hostConnector: async () => ({hostKeyFingerprint: "SHA256/host-key-1", capacity: {cpuCount: 4}}),
  });
  const service = createRemoteHostService(deps);
  const host = await service.registerRemoteHost("owner-a", {displayName: "Home", address: "home.example.com"});
  const firstTest = await service.testRemoteHost("owner-a", host.hostId);
  assert.equal(firstTest.ready, false);
  assert.equal(firstTest.observedHostKeyFingerprint, "SHA256/host-key-1");
  await assert.rejects(
    () => service.updateRemoteHost("owner-a", host.hostId, {hostKeyFingerprint: "SHA256/host-key-1"}),
    /remote_host_key_confirmation_required/,
  );
  await service.updateRemoteHost("owner-a", host.hostId, {
    hostKeyFingerprint: "SHA256/host-key-1", confirmHostKey: true,
  });
  const ready = await service.testRemoteHost("owner-a", host.hostId);
  assert.equal(ready.ready, true);
  assert.equal(ready.host.status, HOST_STATUS.READY);

  deps.hostConnector = async () => ({hostKeyFingerprint: "SHA256/changed-key"});
  await assert.rejects(() => service.testRemoteHost("owner-a", host.hostId), /remote_host_key_mismatch/);
  assert.equal((await service.getRemoteHost("owner-a", host.hostId)).status, HOST_STATUS.ERROR);
});

test("blocks removal while referenced and revokes an unused host without deleting VMs", async () => {
  const deps = dependencies();
  const service = createRemoteHostService(deps);
  const host = await service.registerRemoteHost("owner-a", {displayName: "Home", address: "home.example.com"});
  await deps.db.collection("workspaces").doc("workspace-1").set({ownerUid: "owner-a", hostId: host.hostId});
  await assert.rejects(() => service.removeRemoteHost("owner-a", host.hostId), /remote_host_referenced/);
  await deps.db.collection("workspaces").doc("workspace-1").set({ownerUid: "owner-a"});
  const result = await service.removeRemoteHost("owner-a", host.hostId);
  assert.equal(result.ok, true);
  await assert.rejects(() => service.getRemoteHost("owner-a", host.hostId), /remote_host_not_found/);
  const privateDoc = await deps.db.collection("users").doc("owner-a").collection("private")
      .doc("remoteHosts").collection("entries").doc(host.hostId).get();
  assert.equal(privateDoc.exists, false);
  assert.match(result.removalInstructions, /authorized_keys/);
});

test("rejects loopback, private and metadata host addresses", () => {
  for (const address of ["localhost", "127.0.0.1", "10.0.0.5", "169.254.169.254", "metadata.google.internal"]) {
    assert.throws(() => normalizeHostAddress(address), /remote_host_address_disallowed/);
  }
  assert.equal(normalizeHostAddress("home.example.com"), "home.example.com");
});

console.log("remote host service tests passed");
