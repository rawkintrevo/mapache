"use strict";

const {hasAutomationAgentAuthority} = require("./automationAgentAdmission.helpers");

const {db: defaultDb} = require("./backendContext");
const {httpError} = require("./backendUtils.helpers");

const LIVE_SESSION_STATUSES = new Set(["running", "ready"]);

function createAutomationAgentApiService(dependencies = {}) {
  if (!dependencies.authService || typeof dependencies.authService.verifyToken !== "function") {
    throw new Error("Automation agent API requires an auth service.");
  }
  return {
    handleRequest: (request, route) => handleRequest(request, route, dependencies),
  };
}

async function handleRequest(request = {}, route = {}, dependencies = {}) {
  const claims = dependencies.authService.verifyToken(readBearerToken(request));
  await assertCurrentAdmission(claims, dependencies);
  const actor = {uid: claims.ownerUid, type: "agent", sessionId: claims.sessionId};
  const definitions = dependencies.definitionsService;
  const runs = dependencies.runsService;
  const history = dependencies.historyService;
  const cleanup = dependencies.cleanupService;
  const body = request.body && typeof request.body === "object" ? request.body : {};
  const query = request.query && typeof request.query === "object" ? request.query : {};
  const actorContext = {actorType: "agent", sessionId: claims.sessionId};

  switch (`${route.resource}:${route.action}`) {
    case "definitions:list":
      if (request.method === "GET") {
        return {body: {automations: await definitions.listAutomations(claims.ownerUid, claims.workspaceId)}};
      }
      if (request.method === "POST") {
        return {status: 201, body: {automation: await definitions.createAutomation(
          claims.ownerUid, claims.workspaceId, body, actorContext,
        )}};
      }
      break;
    case "definition:detail":
      if (request.method === "GET") {
        return {body: {automation: await definitions.getAutomation(claims.ownerUid, claims.workspaceId, route.automationId)}};
      }
      if (request.method === "PATCH") {
        return {body: {automation: await definitions.updateAutomation(
          claims.ownerUid, claims.workspaceId, route.automationId, body, actorContext,
        )}};
      }
      if (request.method === "DELETE") {
        return {body: await definitions.deleteAutomation(
          claims.ownerUid, claims.workspaceId, route.automationId, body, actorContext,
        )};
      }
      break;
    case "run:enqueue":
      requireMethod(request, "POST");
      return {status: 201, body: {run: await runs.enqueueRun({
        actor,
        aid: route.automationId,
        occurrence: body.occurrence,
        trigger: body.trigger || "manual",
        idempotencyKey: requestHeader(request, "idempotency-key") || body.idempotencyKey,
        wid: claims.workspaceId,
      })}};
    case "settings:detail":
      if (request.method === "GET") {
        return {body: await definitions.getAutomationSettings(claims.ownerUid, claims.workspaceId)};
      }
      if (request.method === "PATCH") {
        return {body: await definitions.updateAutomationSettings(
          claims.ownerUid, claims.workspaceId, body, actorContext,
        )};
      }
      break;
    case "schedule:preview":
      requireMethod(request, "POST");
      if (typeof dependencies.previewAutomationSchedule !== "function") {
        throw httpError(503, "automation_schedule_preview_unavailable");
      }
      return {body: dependencies.previewAutomationSchedule(body)};
    case "runs:list":
      requireMethod(request, "GET");
      return {body: await history.listRuns(claims.ownerUid, {...query, workspaceId: claims.workspaceId})};
    case "run:detail":
      requireMethod(request, "GET");
      await assertRunBelongsToWorkspace(route.runId, claims, dependencies);
      return {body: {run: await history.getRun(claims.ownerUid, route.runId)}};
    case "events:list":
      requireMethod(request, "GET");
      await assertRunBelongsToWorkspace(route.runId, claims, dependencies);
      return {body: await history.listEvents(claims.ownerUid, route.runId, query)};
    case "run:cancel":
      requireMethod(request, "POST");
      await assertRunBelongsToWorkspace(route.runId, claims, dependencies);
      return {body: await runs.cancelQueuedRun(actor, route.runId)};
    case "run:stop":
      requireMethod(request, "POST");
      await assertRunBelongsToWorkspace(route.runId, claims, dependencies);
      return {body: await cleanup.stopRun(actor, route.runId)};
    case "run:restart":
      requireMethod(request, "POST");
      await assertRunBelongsToWorkspace(route.runId, claims, dependencies);
      return {status: 201, body: {run: await runs.restartRun(actor, route.runId, {
        idempotencyKey: requestHeader(request, "idempotency-key") || body.idempotencyKey,
      })}};
    default:
      break;
  }
  throw httpError(404, "not_found");
}

async function assertCurrentAdmission(claims, dependencies) {
  const firestore = dependencies.db || defaultDb;
  const sessionSnap = await dependencies.sessionCollection(claims.workspaceId).doc(claims.sessionId).get();
  const session = sessionSnap.exists ? sessionSnap.data() || {} : null;
  const workspaceSnap = await firestore.collection("workspaces").doc(claims.workspaceId).get();
  const workspace = workspaceSnap.exists ? workspaceSnap.data() || {} : null;
  if (!session || !workspace || workspace.ownerUid !== claims.ownerUid || session.ownerUid !== claims.ownerUid ||
      session.workspaceId !== claims.workspaceId || !hasAutomationAgentAuthority(session, workspace) ||
      !LIVE_SESSION_STATUSES.has(String(session.status || "").trim().toLowerCase()) ||
      session.agentRuntimeAuthorityState !== "admitted" ||
      session.agentRuntimeSessionId !== claims.sessionId ||
      String(session.agentRuntimeGeneration || "") !== String(claims.generation) ||
      session.agentRuntimeBootInstanceId !== claims.bootInstanceId ||
      workspace.deleted === true || isDeletedLifecycle(workspace.lifecycle || workspace.status)) {
    throw httpError(401, "automation_agent_unauthorized");
  }
  return {session, workspace};
}

async function assertRunBelongsToWorkspace(runId, claims, dependencies) {
  const firestore = dependencies.db || defaultDb;
  const snap = await firestore.collection("automationRuns").doc(cleanId(runId)).get();
  const run = snap.exists ? snap.data() || {} : null;
  if (!run || run.ownerUid !== claims.ownerUid || run.workspaceId !== claims.workspaceId) {
    throw httpError(404, "automation_run_not_found");
  }
  return run;
}

function readBearerToken(request) {
  const value = requestHeader(request, "authorization");
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  if (!match) throw httpError(401, "automation_agent_unauthorized");
  return match[1];
}

function requestHeader(request, name) {
  if (typeof request.get === "function") return String(request.get(name) || "");
  return String(request.headers?.[name.toLowerCase()] || "");
}

function requireMethod(request, expected) {
  if (String(request.method || "").toUpperCase() !== expected) throw httpError(405, "method_not_allowed");
}

function cleanId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) throw httpError(400, "invalid_automation_run_id");
  return id;
}

function isDeletedLifecycle(value) {
  return ["deleting", "deleted"].includes(String(value || "").trim().toLowerCase());
}

module.exports = {
  assertCurrentAdmission,
  createAutomationAgentApiService,
  handleRequest,
};
