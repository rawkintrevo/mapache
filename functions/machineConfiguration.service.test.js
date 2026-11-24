"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createMachineConfigurationService} = require("./machineConfiguration.service");

class Ref {
  constructor(db, path, id) { this.db = db; this.path = path; this.id = id; }
  async get() { const value = this.db.data.get(this.path); return {exists: value !== undefined, data: () => value, id: this.id}; }
  collection(name) { return new Collection(this.db, `${this.path}/${name}`); }
  async update(value) { this.db.data.set(this.path, {...(this.db.data.get(this.path) || {}), ...value}); }
}
class Collection {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return new Ref(this.db, `${this.path}/${id}`, id); }
}
class Db {
  constructor() { this.data = new Map(); }
  collection(name) { return new Collection(this, name); }
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: async (ref) => ref instanceof Collection ? {docs: [...this.data.entries()].filter(([key]) => key.startsWith(`${ref.path}/`) && !key.slice(ref.path.length + 1).includes("/")).map(([key, value]) => ({data: () => value, id: key.split("/").pop()}))} : ref.get(),
      update: (ref, value) => writes.push({ref, value}),
    };
    const result = await callback(transaction);
    for (const write of writes) this.data.set(write.ref.path, {...(this.data.get(write.ref.path) || {}), ...write.value});
    return result;
  }
}

function setup() {
  const db = new Db();
  db.data.set("workspaces/workspace-1", {ownerUid: "owner-1"});
  return {db, service: createMachineConfigurationService({
    admin: {firestore: {FieldValue: {serverTimestamp: () => "SERVER"}}},
    db,
  })};
}

test("configuration updates are versioned and expose no secret values", async () => {
  const {db, service} = setup();
  const result = await service.updateConfiguration("owner-1", "workspace-1", {
    description: "Laptop",
    environmentEntryIds: ["env-1", "env-1"],
    piAuthEntryId: "auth-1",
    idleStopMinutes: 30,
  });
  assert.equal(result.desiredVersion, 1);
  assert.deepEqual(result.desired.environmentEntryIds, ["env-1"]);
  assert.equal(Object.hasOwn(result, "secret"), false);
  assert.equal(db.data.get("workspaces/workspace-1").machineConfig.state, "pending");
});

test("stale configuration writes are rejected", async () => {
  const {service} = setup();
  await service.updateConfiguration("owner-1", "workspace-1", {description: "first"});
  await assert.rejects(service.updateConfiguration("owner-1", "workspace-1", {expectedVersion: 0}), /machine_configuration_conflict/);
});

test("a migration fence blocks desired changes and applied callbacks", async () => {
  const {db, service} = setup();
  const workspace = "workspaces/workspace-1";
  const fence = "vmMigrationFences_v2/workspace-1";
  const config = await service.updateConfiguration("owner-1", "workspace-1", {description: "pending"});
  db.data.set(fence, {});
  await assert.rejects(service.updateConfiguration("owner-1", "workspace-1", {description: "blocked"}),
      {publicMessage: "workspace_vm_migration_active"});
  assert.deepEqual(await service.markApplied("workspace-1", 1), config);
  assert.equal(db.data.get(workspace).machineConfig.appliedVersion, 0);
  db.data.delete(fence);
  assert.equal((await service.markApplied("workspace-1", 1)).appliedVersion, 1);
  assert.equal((await service.markApplied("workspace-1", 0)).appliedVersion, 1);
});
