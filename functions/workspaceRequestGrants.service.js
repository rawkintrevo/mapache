"use strict";

const crypto = require("node:crypto");
const {db: defaultDb, admin: defaultAdmin} = require("./backendContext");
const {httpError, serialize} = require("./backendUtils.helpers");

const PERMISSIONS = Object.freeze(["discover", "submit", "read", "reply", "cancel"]);
const PERMISSION_SET = new Set(PERMISSIONS);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function createWorkspaceRequestGrantsService(dependencies = {}) {
  const shared = {
    db: dependencies.db || defaultDb,
    admin: dependencies.admin || defaultAdmin,
    ticketService: dependencies.ticketService,
    enqueueWorkspaceRun: dependencies.enqueueWorkspaceRun,
  };
  return {
    listGrants: (uid, sourceWorkspaceId) => listGrants(uid, sourceWorkspaceId, shared),
    getGrant: (uid, sourceWorkspaceId, targetWorkspaceId) => getGrant(uid, sourceWorkspaceId, targetWorkspaceId, shared),
    saveGrant: (uid, sourceWorkspaceId, targetWorkspaceId, body) => saveGrant(uid, sourceWorkspaceId, targetWorkspaceId, body, shared),
    revokeGrant: (uid, sourceWorkspaceId, targetWorkspaceId) => revokeGrant(uid, sourceWorkspaceId, targetWorkspaceId, shared),
    discoverTargets: (claims) => discoverTargets(claims, shared),
    submitRequest: (claims, body, options) => submitRequest(claims, body, options, shared),
    getRequest: (claims, ticketId) => getRequest(claims, ticketId, shared),
    replyRequest: (claims, ticketId, body) => replyRequest(claims, ticketId, body, shared),
    cancelRequest: (claims, ticketId) => cancelRequest(claims, ticketId, shared),
  };
}

async function saveGrant(uid, sourceWorkspaceId, targetWorkspaceId, body = {}, dependencies) {
  const sourceId = cleanId(sourceWorkspaceId, "source_workspace_id");
  const targetId = cleanId(targetWorkspaceId, "target_workspace_id");
  const permissions = normalizePermissions(body.permissions);
  if (!permissions.length) throw httpError(400, "request_grant_permissions_required");
  const [source, target] = await Promise.all([getWorkspace(dependencies.db, sourceId), getWorkspace(dependencies.db, targetId)]);
  if (!source || !target) throw httpError(404, "workspace_not_found");
  if (source.ownerUid !== uid || target.ownerUid !== uid) throw httpError(403, "workspace_forbidden");
  if (sourceId === targetId) throw httpError(400, "request_grant_same_workspace");
  const ref = grantRef(dependencies.db, uid, sourceId, targetId);
  const existing = await ref.get();
  const current = existing.exists ? existing.data() || {} : {};
  const revision = Number(current.revision || 0) + 1;
  const now = dependencies.admin.firestore.FieldValue.serverTimestamp();
  const grant = {
    ownerUid: uid,
    sourceWorkspaceId: sourceId,
    targetWorkspaceId: targetId,
    permissions,
    enabled: body.enabled !== false,
    revision,
    updatedAt: now,
    ...(existing.exists ? {} : {createdAt: now}),
  };
  await ref.set(grant, {merge: true});
  return serialize({id: ref.id, ...current, ...grant});
}

async function revokeGrant(uid, sourceWorkspaceId, targetWorkspaceId, dependencies) {
  const grant = await getGrant(uid, sourceWorkspaceId, targetWorkspaceId, dependencies);
  if (!grant) throw httpError(404, "request_grant_not_found");
  const ref = grantRef(dependencies.db, uid, cleanId(sourceWorkspaceId), cleanId(targetWorkspaceId));
  await ref.update({enabled: false, revision: Number(grant.revision || 0) + 1, updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp()});
  return getGrant(uid, sourceWorkspaceId, targetWorkspaceId, dependencies);
}

async function listGrants(uid, sourceWorkspaceId, dependencies) {
  let query = dependencies.db.collection("workspaceRequestGrants").where("ownerUid", "==", uid);
  if (sourceWorkspaceId) query = query.where("sourceWorkspaceId", "==", cleanId(sourceWorkspaceId, "workspace_id"));
  const snap = await query.get();
  return serialize(snap.docs.map((doc) => ({id: doc.id, ...doc.data()})));
}

async function getGrant(uid, sourceWorkspaceId, targetWorkspaceId, dependencies) {
  const sourceId = cleanId(sourceWorkspaceId, "source_workspace_id");
  const targetId = cleanId(targetWorkspaceId, "target_workspace_id");
  const snap = await grantRef(dependencies.db, uid, sourceId, targetId).get();
  return snap.exists ? serialize({id: snap.id, ...snap.data()}) : null;
}

async function discoverTargets(claims, dependencies) {
  const sourceId = cleanId(claims.workspaceId, "source_workspace_id");
  const grants = await listGrantsForSource(dependencies.db, claims.ownerUid, sourceId);
  const visible = [];
  for (const grant of grants) {
    if (!grant.enabled || !grant.permissions.includes("discover")) continue;
    const workspace = await getWorkspace(dependencies.db, grant.targetWorkspaceId);
    if (!workspace || workspace.ownerUid !== claims.ownerUid || workspace.deleted === true) continue;
    visible.push({
      workspaceId: grant.targetWorkspaceId,
      name: String(workspace.name || grant.targetWorkspaceId),
      sourceWorkspaceId: sourceId,
      permissions: grant.permissions,
      grantRevision: grant.revision,
    });
  }
  return visible;
}

async function submitRequest(claims, body = {}, options = {}, dependencies) {
  const targetId = cleanId(body.targetWorkspaceId, "target_workspace_id");
  await requirePermission(claims, targetId, "submit", dependencies);
  const target = await getWorkspace(dependencies.db, targetId);
  if (!target || target.ownerUid !== claims.ownerUid) throw httpError(404, "request_target_not_found");
  if (!dependencies.ticketService?.createTicket) throw httpError(503, "workspace_request_unavailable");
  const source = cleanId(claims.workspaceId, "source_workspace_id");
  const key = String(options.idempotencyKey || body.idempotencyKey || "").trim();
  const ticket = await dependencies.ticketService.createTicket(
      {uid: claims.ownerUid, type: "agent", sessionId: claims.sessionId}, targetId,
      {request: body.request || body.instructions, context: body.context, desiredOutput: body.desiredOutput, model: body.model, resources: body.resources},
      {
        idempotencyKey: key ? `${source}:${key}` : undefined,
        source: {type: "workspace_agent", id: source},
      },
  );
  const ref = dependencies.db.collection("workspaceTickets").doc(ticket.id);
  const request = {...(ticket.request || {}), actor: {type: "workspace_agent", sourceWorkspaceId: source, sourceSessionId: claims.sessionId}};
  await ref.update({sourceOwnerUid: claims.ownerUid, sourceWorkspaceId: source, sourceSessionId: claims.sessionId, request});
  return callerSafeTicket({...ticket, sourceWorkspaceId: source, request});
}

async function getRequest(claims, ticketId, dependencies) {
  return callerSafeTicket(await readAuthorizedTicket(claims, ticketId, "read", dependencies));
}

async function replyRequest(claims, ticketId, body, dependencies) {
  const ticket = await readAuthorizedTicket(claims, ticketId, "reply", dependencies);
  const message = String(body?.message || body?.instructions || "").trim();
  if (!message) throw httpError(400, "request_reply_required");
  if (typeof dependencies.enqueueWorkspaceRun !== "function") throw httpError(503, "workspace_request_unavailable");
  const priorRequest = ticket.request || {};
  const continuation = {
    ...priorRequest,
    instructions: `${String(priorRequest.instructions || "").slice(0, 32768)}\n\nFollow-up from the source workspace:\n${message}`.slice(0, 32768),
    triggerKind: "http_ticket",
    triggerReference: ticket.id,
    source: priorRequest.source || {type: "workspace_agent", id: claims.workspaceId},
    sinks: [{kind: "ticket_result", reference: ticket.id}],
  };
  const run = await dependencies.enqueueWorkspaceRun({
    actor: {uid: ticket.ownerUid, type: "agent", sessionId: claims.sessionId},
    wid: ticket.workspaceId,
    ticketId: ticket.id,
    runId: `ticket-${ticket.id}-reply-${crypto.randomUUID()}`,
    rootRunId: ticket.runId || ticket.id,
    trigger: "http_ticket",
    runRequest: continuation,
  });
  await dependencies.db.collection("workspaceTickets").doc(ticket.id).update({
    runId: run.id || run.runId,
    reply: {message: message.slice(0, 32768), at: dependencies.admin.firestore.FieldValue.serverTimestamp()},
    status: run.status,
    updatedAt: dependencies.admin.firestore.FieldValue.serverTimestamp(),
  });
  return callerSafeTicket(await readTicket(dependencies.db, ticket.id));
}

async function cancelRequest(claims, ticketId, dependencies) {
  const ticket = await readAuthorizedTicket(claims, ticketId, "cancel", dependencies);
  await dependencies.ticketService.cancelTicket({uid: claims.ownerUid}, ticketId);
  return callerSafeTicket(await readTicket(dependencies.db, ticketId));
}

async function readAuthorizedTicket(claims, ticketId, permission, dependencies) {
  const ticket = await readTicket(dependencies.db, ticketId);
  if (!ticket || ticket.sourceOwnerUid !== claims.ownerUid || ticket.sourceWorkspaceId !== claims.workspaceId) throw httpError(404, "request_not_found");
  await requirePermission(claims, ticket.workspaceId, permission, dependencies);
  return ticket;
}

async function requirePermission(claims, targetWorkspaceId, permission, dependencies) {
  const grant = await getGrant(claims.ownerUid, claims.workspaceId, targetWorkspaceId, dependencies);
  if (!grant || !grant.enabled || !grant.permissions.includes(permission)) throw httpError(403, "request_permission_denied");
  return grant;
}

async function listGrantsForSource(db, ownerUid, sourceWorkspaceId) {
  const snap = await db.collection("workspaceRequestGrants").where("ownerUid", "==", ownerUid).where("sourceWorkspaceId", "==", sourceWorkspaceId).get();
  return snap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
}

async function readTicket(db, ticketId) {
  const id = cleanId(ticketId, "ticket_id");
  const snap = await db.collection("workspaceTickets").doc(id).get();
  return snap.exists ? {id: snap.id, ...snap.data()} : null;
}

async function getWorkspace(db, workspaceId) {
  const snap = await db.collection("workspaces").doc(workspaceId).get();
  return snap.exists ? snap.data() || {} : null;
}

function callerSafeTicket(ticket) {
  const result = {
    id: ticket.id,
    workspaceId: ticket.workspaceId,
    sourceWorkspaceId: ticket.sourceWorkspaceId,
    status: ticket.status,
    runId: ticket.runId || null,
    result: ticket.result || null,
    reply: ticket.reply || null,
    errorCode: ticket.errorCode || null,
    createdAt: ticket.createdAt || null,
    updatedAt: ticket.updatedAt || null,
  };
  return result;
}

function grantRef(db, uid, sourceId, targetId) {
  const id = crypto.createHash("sha256").update(`${uid}/${sourceId}/${targetId}`).digest("hex");
  return db.collection("workspaceRequestGrants").doc(id);
}

function normalizePermissions(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String))].filter((permission) => PERMISSION_SET.has(permission));
}

function cleanId(value, field = "id") {
  const id = String(value || "").trim();
  if (!ID.test(id)) throw httpError(400, `invalid_${field}`);
  return id;
}

module.exports = {PERMISSIONS, createWorkspaceRequestGrantsService, callerSafeTicket};
