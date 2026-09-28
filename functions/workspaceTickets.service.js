"use strict";

const crypto = require("node:crypto");
const {db: defaultDb, admin: defaultAdmin} = require("./backendContext");
const {httpError, serialize} = require("./backendUtils.helpers");
const {normalizeWorkspaceRunRequest} = require("./workspaceRunContract.helpers");

function createWorkspaceTicketsService(dependencies = {}) {
  const shared = {
    db: dependencies.db || defaultDb,
    admin: dependencies.admin || defaultAdmin,
    enqueueWorkspaceRun: dependencies.enqueueWorkspaceRun,
    cancelQueuedRun: dependencies.cancelQueuedRun,
    getRun: dependencies.getRun,
  };
  return {
    createTicket: (actor, workspaceId, body, options = {}) => createTicket(actor, workspaceId, body, options, shared),
    getTicket: (actor, ticketId) => getTicket(actor, ticketId, shared),
    cancelTicket: (actor, ticketId) => cancelTicket(actor, ticketId, shared),
  };
}

async function createTicket(actor, workspaceId, body = {}, options = {}, dependencies = {}) {
  const uid = actorUid(actor);
  const targetWorkspaceId = cleanId(workspaceId, "workspace_id");
  const request = normalizeWorkspaceRunRequest({
    targetWorkspaceId,
    actor: {type: "user", id: uid},
    source: options.source || {type: "http_ticket", id: String(options.idempotencyKey || "request").slice(0, 200)},
    triggerKind: "http_ticket",
    triggerReference: options.idempotencyKey || null,
    instructions: body.request || body.instructions,
    input: body.context === undefined && body.desiredOutput === undefined ? null : {
      context: body.context || null,
      desiredOutput: body.desiredOutput || null,
    },
    contextSnapshotRefs: body.contextSnapshotRefs || [],
    model: body.model || null,
    resources: body.resources || null,
    sinks: [{kind: "ticket_result"}],
    provenance: {source: "http_ticket", reference: options.idempotencyKey || null},
  });
  const ticketId = ticketIdFor(uid, targetWorkspaceId, options.idempotencyKey);
  const ticketRef = dependencies.db.collection("workspaceTickets").doc(ticketId);
  let ticket;
  await dependencies.db.runTransaction(async (transaction) => {
    const workspaceRef = dependencies.db.collection("workspaces").doc(targetWorkspaceId);
    const workspaceSnap = await transaction.get(workspaceRef);
    if (!workspaceSnap.exists) throw httpError(404, "workspace_not_found");
    const workspace = workspaceSnap.data() || {};
    if (workspace.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
    const existing = await transaction.get(ticketRef);
    if (existing.exists) {
      ticket = {id: ticketId, ...existing.data()};
      return;
    }
    const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
    ticket = {id: ticketId, ownerUid: uid, workspaceId: targetWorkspaceId, request, status: "submitting", createdAt: now, updatedAt: now};
    transaction.set(ticketRef, ticket);
  });
  if (ticket.status !== "submitting") return serialize(ticket);
  try {
    const run = await dependencies.enqueueWorkspaceRun({
      actor,
      wid: targetWorkspaceId,
      ticketId,
      runRequest: request,
    });
    const update = {runId: run.id, status: run.status, updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp()};
    await ticketRef.update(update);
    return serialize({...ticket, ...update});
  } catch (error) {
    await ticketRef.update({status: "failed", errorCode: String(error.publicMessage || error.code || "ticket_submission_failed"), updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp()});
    throw error;
  }
}

async function getTicket(actor, ticketId, dependencies = {}) {
  const uid = actorUid(actor);
  const ref = dependencies.db.collection("workspaceTickets").doc(cleanId(ticketId, "ticket_id"));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "ticket_not_found");
  const ticket = snap.data() || {};
  if (ticket.ownerUid !== uid) throw httpError(403, "ticket_forbidden");
  const result = {...ticket};
  delete result.request?.actor;
  if (ticket.runId && typeof dependencies.getRun === "function") {
    const run = await dependencies.getRun(uid, ticket.runId);
    result.status = run.status;
    result.run = run;
  }
  return serialize({id: snap.id, ...result});
}

async function cancelTicket(actor, ticketId, dependencies = {}) {
  const uid = actorUid(actor);
  const ref = dependencies.db.collection("workspaceTickets").doc(cleanId(ticketId, "ticket_id"));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "ticket_not_found");
  const ticket = snap.data() || {};
  if (ticket.ownerUid !== uid) throw httpError(403, "ticket_forbidden");
  if (ticket.runId && typeof dependencies.cancelQueuedRun === "function") {
    await dependencies.cancelQueuedRun(actor, ticket.runId);
  }
  await ref.update({status: "canceled", updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp()});
  return getTicket(actor, ticketId, dependencies);
}

function ticketIdFor(uid, workspaceId, idempotencyKey) {
  if (idempotencyKey) return crypto.createHash("sha256").update(`${uid}/${workspaceId}/${idempotencyKey}`).digest("hex");
  return crypto.randomUUID();
}

function actorUid(actor) {
  const uid = typeof actor === "string" ? actor : actor?.uid;
  if (!uid || typeof uid !== "string") throw httpError(401, "unauthenticated");
  return uid;
}

function cleanId(value, field) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) throw httpError(400, `invalid_${field}`);
  return id;
}

module.exports = {createWorkspaceTicketsService, ticketIdFor};
