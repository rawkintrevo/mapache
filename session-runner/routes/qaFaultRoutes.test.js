"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {registerQaFaultRoutes} = require("./qaFaultRoutes");

function createApp() {
  const routes = {};
  return {
    routes,
    get(path, middleware, handler) { routes[`GET ${path}`] = [middleware, handler]; },
    post(path, middleware, handler) { routes[`POST ${path}`] = [middleware, handler]; },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; },
  };
}

test("QA fault routes require runner access and expose bounded actions", async () => {
  const app = createApp();
  const calls = [];
  const faultHarness = {
    enabled: () => true,
    status: async () => ({enabled: true}),
    arm: async (fault) => ({ok: true, fault}),
    revokeWriter: async () => ({ok: true, state: "revoked"}),
    forceLoss: async () => ({ok: true, state: "forced-loss-scheduled"}),
    reset: async () => ({enabled: true, reset: true}),
  };
  registerQaFaultRoutes({app, faultHarness, hasRunnerAccess: (req) => req.allowed});

  const unauthorized = response();
  app.routes["GET /qa/faults/status"][0]({allowed: false}, unauthorized, () => calls.push("next"));
  assert.equal(unauthorized.statusCode, 404);
  assert.deepEqual(unauthorized.body, {error: "not_found"});

  const status = response();
  await app.routes["GET /qa/faults/status"][1]({allowed: true}, status);
  assert.deepEqual(status.body, {enabled: true});

  const armed = response();
  await app.routes["POST /qa/faults"][1]({body: {action: "arm", fault: "storage-publication"}, allowed: true}, armed);
  assert.deepEqual(armed.body, {ok: true, fault: "storage-publication"});

  const rejected = response();
  await app.routes["POST /qa/faults"][1]({body: {action: "unknown"}, allowed: true}, rejected);
  assert.equal(rejected.statusCode, 400);
  assert.deepEqual(rejected.body, {error: "qa_fault_action_unknown"});
});
