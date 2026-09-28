"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createWorkspaceRequestGrantsService} = require("./workspaceRequestGrants.service");

class Ref {
  constructor(db, path, id) { this.db = db; this.path = path; this.id = id; }
  async get() { const value = this.db.values.get(this.path); return {id: this.id, exists: value !== undefined, data: () => value}; }
  async set(value) { this.db.values.set(this.path, {...(this.db.values.get(this.path) || {}), ...value}); }
  async update(value) { this.db.values.set(this.path, {...(this.db.values.get(this.path) || {}), ...value}); }
}
class Query {
  constructor(db, path, filters = []) { this.db = db; this.path = path; this.filters = filters; }
  doc(id) { return new Ref(this.db, `${this.path}/${id}`, id); }
  where(field, op, value) { return new Query(this.db, this.path, [...this.filters, [field, op, value]]); }
  async get() {
    const docs = [...this.db.values.entries()]
        .filter(([path]) => path.startsWith(`${this.path}/`))
        .map(([path, value]) => ({id: path.split("/").pop(), data: () => value}))
        .filter((doc) => this.filters.every(([field, op, value]) => op === "==" && doc.data()[field] === value));
    return {docs};
  }
}
class Db {
  constructor() { this.values = new Map(); }
  collection(name) { return new Query(this, name); }
  doc(path) { return new Ref(this, path, path.split("/").pop()); }
}

function setup() {
  const db = new Db();
  db.values.set("workspaces/source", {ownerUid: "owner", name: "Source"});
  db.values.set("workspaces/target", {ownerUid: "owner", name: "Customer Research"});
  const admin = {firestore: {FieldValue: {serverTimestamp: () => "now"}}};
  const ticketService = {
    async createTicket(_actor, workspaceId, body, options) {
      const id = "ticket-1";
      db.values.set(`workspaceTickets/${id}`, {
        id, ownerUid: "owner", workspaceId, status: "queued", runId: "run-1",
        request: {instructions: body.request}, createdAt: "now", updatedAt: "now",
      });
      return {id, workspaceId, status: "queued", runId: "run-1", request: {instructions: body.request}, createdAt: "now", updatedAt: "now"};
    },
    async cancelTicket() { return {}; },
  };
  const enqueueWorkspaceRun = async (input) => ({id: input.runId, status: "queued"});
  return {db, service: createWorkspaceRequestGrantsService({db, admin, enqueueWorkspaceRun, ticketService})};
}

const claims = {ownerUid: "owner", workspaceId: "source", sessionId: "session-1"};

test("owner creates directional grant and agent discovers only permitted targets", async () => {
  const {service} = setup();
  await service.saveGrant("owner", "source", "target", {permissions: ["discover", "submit", "read"]});
  assert.deepEqual((await service.discoverTargets(claims)).map((target) => target.workspaceId), ["target"]);
  assert.deepEqual(await service.discoverTargets({...claims, workspaceId: "target"}), []);
});

test("agent request uses grant and returns a caller-safe projection", async () => {
  const {service} = setup();
  await service.saveGrant("owner", "source", "target", {permissions: ["discover", "submit", "read"]});
  const result = await service.submitRequest(claims, {targetWorkspaceId: "target", request: "Summarize complaints"}, {idempotencyKey: "one"});
  assert.deepEqual(result, {
    id: "ticket-1", workspaceId: "target", sourceWorkspaceId: "source", status: "queued", runId: "run-1",
    result: null, reply: null, errorCode: null, createdAt: "now", updatedAt: "now",
  });
  assert.equal((await service.getRequest(claims, "ticket-1")).request, undefined);
});

test("reply creates a linked continuation run on the same ticket", async () => {
  const {service, db} = setup();
  await service.saveGrant("owner", "source", "target", {permissions: ["submit", "reply"]});
  await service.submitRequest({ownerUid: "owner", workspaceId: "source", sessionId: "session-1"}, {targetWorkspaceId: "target", request: "Initial request"}, {idempotencyKey: "reply-test"});
  const result = await service.replyRequest({ownerUid: "owner", workspaceId: "source", sessionId: "session-1"}, "ticket-1", {message: "Please include one more example."});
  assert.match(result.reply.message, /one more example/);
  assert.match(result.runId, /^ticket-ticket-1-reply-/);
  assert.equal(db.values.get("workspaceTickets/ticket-1").status, "queued");
});

test("reply and cancel permissions do not implicitly require read access", async () => {
  const {service} = setup();
  await service.saveGrant("owner", "source", "target", {permissions: ["submit", "cancel"]});
  await service.submitRequest(claims, {targetWorkspaceId: "target", request: "Cancel this"});
  await service.cancelRequest(claims, "ticket-1");

  const {service: replyService} = setup();
  await replyService.saveGrant("owner", "source", "target", {permissions: ["submit", "reply"]});
  await replyService.submitRequest(claims, {targetWorkspaceId: "target", request: "Reply to this"});
  const result = await replyService.replyRequest(claims, "ticket-1", {message: "Follow up"});
  assert.equal(result.status, "queued");
});

test("revoked grant blocks new requests", async () => {
  const {service} = setup();
  await service.saveGrant("owner", "source", "target", {permissions: ["submit", "read"]});
  await service.revokeGrant("owner", "source", "target");
  await assert.rejects(service.submitRequest(claims, {targetWorkspaceId: "target", request: "No"}), /request_permission_denied/);
});
