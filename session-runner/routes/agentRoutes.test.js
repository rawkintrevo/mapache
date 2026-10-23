"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {registerAgentRoutes} = require("./agentRoutes");

function createFakeApp() {
  const routes = [];
  return {
    get(path, handler) { routes.push({method: "GET", path, handler}); },
    post(path, handler) { routes.push({method: "POST", path, handler}); },
    routes,
  };
}

function createResponse() {
  return {
    body: null,
    statusCode: 200,
    json(body) { this.body = body; return this; },
    status(statusCode) { this.statusCode = statusCode; return this; },
  };
}

test("workspace request routes require runner access and delegate control", async () => {
  const app = createFakeApp();
  const calls = [];
  registerAgentRoutes({
    app,
    hasRunnerAccess: (req) => req.authorized === true,
    piWebUi: {
      startWorkspaceRequest: async (body) => { calls.push(["start", body]); return {ok: true}; },
      workspaceRequestStatus: async (runId) => { calls.push(["status", runId]); return {status: "running"}; },
      cancelWorkspaceRequest: async (runId) => { calls.push(["cancel", runId]); return {ok: true}; },
    },
    workspace: {materializeAuthNow: async () => ({})},
  });

  const start = app.routes.find((route) => route.method === "POST" && route.path === "/workspace/requests");
  const status = app.routes.find((route) => route.method === "GET" && route.path === "/workspace/requests/:runId");
  const cancel = app.routes.find((route) => route.method === "POST" && route.path === "/workspace/requests/:runId/cancel");

  const unauthorized = createResponse();
  await start.handler({body: {runId: "run-1"}, authorized: false}, unauthorized);
  assert.equal(unauthorized.statusCode, 404);
  assert.deepEqual(unauthorized.body, {error: "not_found"});

  const started = createResponse();
  await start.handler({body: {runId: "run-1", prompt: "hello"}, authorized: true}, started);
  const current = createResponse();
  await status.handler({params: {runId: "run-1"}, authorized: true}, current);
  const canceled = createResponse();
  await cancel.handler({params: {runId: "run-1"}, authorized: true}, canceled);

  assert.deepEqual(started.body, {ok: true});
  assert.deepEqual(current.body, {status: "running"});
  assert.deepEqual(canceled.body, {ok: true});
  assert.deepEqual(calls, [
    ["start", {runId: "run-1", prompt: "hello"}],
    ["status", "run-1"],
    ["cancel", "run-1"],
  ]);
});

test("workspace request status maps missing requests to 404", async () => {
  const app = createFakeApp();
  registerAgentRoutes({
    app,
    hasRunnerAccess: () => true,
    piWebUi: {workspaceRequestStatus: async () => ({error: "workspace_request_not_found"})},
    workspace: {materializeAuthNow: async () => ({})},
  });
  const route = app.routes.find((candidate) => candidate.method === "GET" && candidate.path === "/workspace/requests/:runId");
  const response = createResponse();
  await route.handler({params: {runId: "missing"}}, response);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {error: "workspace_request_not_found"});
});
