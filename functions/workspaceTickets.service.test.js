"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createWorkspaceTicketsService, ticketIdFor} = require("./workspaceTickets.service");

class Snap { constructor(ref, value) { this.id = ref.id; this.ref = ref; this.value = value; this.exists = value !== undefined; } data() { return this.value; } }
class Ref { constructor(db, path, id) { this.db = db; this.path = path; this.id = id; } async get() { return new Snap(this, this.db.values.get(this.path)); } async update(value) { this.db.values.set(this.path, {...(this.db.values.get(this.path) || {}), ...value}); } }
class Collection { constructor(db, path) { this.db = db; this.path = path; } doc(id) { return new Ref(this.db, `${this.path}/${id}`, id); } }
class Db { constructor() { this.values = new Map(); } collection(name) { return new Collection(this, name); } async runTransaction(fn) { return fn({get: (ref) => ref.get(), set: (ref, value) => this.values.set(ref.path, value), update: (ref, value) => ref.update(value)}); } }

function setup() {
  const db = new Db();
  db.values.set("workspaces/workspace-1", {ownerUid: "user-1", resources: {cpu: "2", memory: "4Gi"}});
  const runs = [];
  const service = createWorkspaceTicketsService({
    db,
    admin: {firestore: {FieldValue: {serverTimestamp: () => "now"}}},
    enqueueWorkspaceRun: async (input) => { const run = {id: `ticket-${input.ticketId}`, status: "queued"}; runs.push(run); return run; },
    getRun: async (_uid, runId) => ({id: runId, status: "queued"}),
    cancelQueuedRun: async () => ({}),
  });
  return {db, runs, service};
}

test("creates an authorized durable ticket through the shared run enqueue path", async () => {
  const {db, runs, service} = setup();
  const ticket = await service.createTicket({uid: "user-1"}, "workspace-1", {request: "Summarize onboarding"}, {idempotencyKey: "req-1"});
  assert.equal(ticket.status, "queued");
  assert.equal(ticket.runId, runs[0].id);
  assert.equal(db.values.get(`workspaceTickets/${ticket.id}`).workspaceId, "workspace-1");
  assert.equal(ticket.id, ticketIdFor("user-1", "workspace-1", "req-1"));
});

test("ticket reads are owner scoped and expose the shared run status", async () => {
  const {service} = setup();
  const created = await service.createTicket({uid: "user-1"}, "workspace-1", {request: "Read status"}, {idempotencyKey: "req-2"});
  const result = await service.getTicket({uid: "user-1"}, created.id);
  assert.equal(result.status, "queued");
  await assert.rejects(service.getTicket({uid: "other"}, created.id), /ticket_forbidden/);
});
