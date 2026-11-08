"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {browserEgressEnvironment} = require("./browserEgress.service");
const {createBrowserEgressManagementService} = require("./browserEgressManagement.service");

class Ref {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }

  async get() {
    const value = this.db.values.get(this.path);
    return {id: this.id, exists: value !== undefined, data: () => value};
  }

  async set(value, options = {}) {
    const current = this.db.values.get(this.path) || {};
    this.db.values.set(this.path, options.merge ? {...current, ...value} : value);
  }

  collection(name) {
    return new Query(this.db, `${this.path}/${name}`);
  }
}

class Query {
  constructor(db, path, filters = []) {
    this.db = db;
    this.path = path;
    this.filters = filters;
  }

  doc(id) {
    return new Ref(this.db, `${this.path}/${id}`, id);
  }

  where(field, operator, value) {
    return new Query(this.db, this.path, [...this.filters, [field, operator, value]]);
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [...this.db.values.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map(([path, value]) => ({id: path.slice(prefix.length), data: () => value}))
        .filter((doc) => this.filters.every(([field, operator, value]) => operator === "==" && doc.data()?.[field] === value));
    return {docs};
  }
}

class Db {
  constructor() {
    this.values = new Map();
  }

  collection(name) {
    return new Query(this, name);
  }
}

const resource = "projects/test-project/secrets/browser-egress/versions/1";
const route = {
  id: "gateway-a",
  enabled: true,
  ownerUid: "owner",
  workspaceIds: ["workspace-1"],
  host: "gateway.example.com",
  port: 22,
  user: "mapache_tunnel",
  hostKey: "ssh-ed25519 AAAA",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n",
};

function setup() {
  const db = new Db();
  db.values.set("workspaces/workspace-1", {ownerUid: "owner", name: "Research"});
  db.values.set("workspaces/workspace-2", {ownerUid: "owner", name: "Production"});
  db.values.set("workspaces/foreign", {ownerUid: "other", name: "Other user"});
  const dependencies = {
    admin: {firestore: {FieldValue: {serverTimestamp: () => "now"}}},
    db,
    readSecret: async () => ({version: 1, routes: [route, {...route, ownerUid: "other", id: "foreign-gateway"}]}),
    resource,
  };
  return {db, dependencies, service: createBrowserEgressManagementService(dependencies)};
}

test("lists only owned gateways and workspace names without credential material", async () => {
  const {service} = setup();

  const result = await service.listGateways("owner");

  assert.deepEqual(result.workspaces, [
    {id: "workspace-2", name: "Production"},
    {id: "workspace-1", name: "Research"},
  ]);
  assert.deepEqual(result.gateways[0], {
    id: "gateway-a",
    host: "gateway.example.com",
    port: 22,
    user: "mapache_tunnel",
    enabled: true,
    workspaceIds: ["workspace-1"],
    workspaces: [{id: "workspace-1", name: "Research"}],
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(result).includes("ssh-ed25519"), false);
});

test("saves owned assignments and provisioning uses them without secret changes", async () => {
  const {db, dependencies, service} = setup();

  const saved = await service.saveAssignments("owner", "gateway-a", {workspaceIds: ["workspace-2"]});
  assert.deepEqual(saved.workspaces, [{id: "workspace-2", name: "Production"}]);
  assert.deepEqual(db.values.get("users/owner/private/browserEgressAssignments/gateways/gateway-a").workspaceIds, ["workspace-2"]);

  const assigned = await browserEgressEnvironment({ownerUid: "owner", workspaceId: "workspace-2"}, dependencies);
  const removed = await browserEgressEnvironment({ownerUid: "owner", workspaceId: "workspace-1"}, dependencies);
  assert.equal(JSON.parse(assigned[0].value).host, route.host);
  assert.deepEqual(removed, []);
});

test("reports and toggles a workspace gateway assignment", async () => {
  const {db, service} = setup();

  assert.deepEqual(await service.getWorkspaceGateway("owner", "workspace-1"), {
    configured: true,
    enabled: true,
    canEnable: false,
    ambiguous: false,
    gateway: {id: "gateway-a", host: "gateway.example.com", port: 22, user: "mapache_tunnel"},
  });
  assert.deepEqual(await service.getWorkspaceGateway("owner", "workspace-2"), {
    configured: true,
    enabled: false,
    canEnable: true,
    ambiguous: false,
    gateway: {id: "gateway-a", host: "gateway.example.com", port: 22, user: "mapache_tunnel"},
  });

  const enabled = await service.setWorkspaceGateway("owner", "workspace-2", {enabled: true});
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.changed, true);
  assert.deepEqual(db.values.get("users/owner/private/browserEgressAssignments/gateways/gateway-a").workspaceIds, [
    "workspace-1", "workspace-2",
  ]);

  const disabled = await service.setWorkspaceGateway("owner", "workspace-1", {enabled: false});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.changed, true);
  assert.deepEqual(db.values.get("users/owner/private/browserEgressAssignments/gateways/gateway-a").workspaceIds, ["workspace-2"]);
});

test("requires one gateway when enabling a workspace without an assignment", async () => {
  const {dependencies, service} = setup();
  const secondRoute = {...route, id: "gateway-b", host: "second-gateway.example.com", workspaceIds: []};
  dependencies.readSecret = async () => ({version: 1, routes: [route, secondRoute]});

  await assert.rejects(
      service.setWorkspaceGateway("owner", "workspace-2", {enabled: true}),
      (error) => error.status === 409 && error.message === "browser_egress_gateway_selection_required",
  );
});

test("rejects forged gateway IDs and foreign workspace IDs", async () => {
  const {service} = setup();

  await assert.rejects(
      service.saveAssignments("owner", "foreign-gateway", {workspaceIds: []}),
      (error) => error.status === 404 && error.message === "browser_egress_gateway_not_found",
  );
  await assert.rejects(
      service.saveAssignments("owner", "gateway-a", {workspaceIds: ["foreign"]}),
      (error) => error.status === 403 && error.message === "workspace_forbidden",
  );
});

test("an explicitly empty assignment revokes a legacy secret allowlist", async () => {
  const {dependencies, service} = setup();

  await service.saveAssignments("owner", "gateway-a", {workspaceIds: []});

  assert.deepEqual(await browserEgressEnvironment({ownerUid: "owner", workspaceId: "workspace-1"}, dependencies), []);
});

test("provisioning rejects an assignment for a workspace owned by another user", async () => {
  const {db, dependencies} = setup();
  db.values.set("users/owner/private/browserEgressAssignments/gateways/gateway-a", {
    ownerUid: "owner",
    gatewayId: "gateway-a",
    workspaceIds: ["foreign"],
  });

  assert.deepEqual(await browserEgressEnvironment({ownerUid: "owner", workspaceId: "foreign"}, dependencies), []);
});
