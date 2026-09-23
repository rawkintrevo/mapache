"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {registerBrowserRoutes} = require("./browserPreviewRoutes");
const {registerWorkspaceRoutes} = require("./workspaceRoutes");
const {registerGoogleMcpRoutes} = require("./googleMcpRoutes");

function createFakeApp() {
  const routes = [];
  const app = {
    all(path, ...handlers) {
      routes.push({method: "ALL", path, handlers});
    },
    delete(path, ...handlers) {
      routes.push({method: "DELETE", path, handlers});
    },
    get(path, ...handlers) {
      routes.push({method: "GET", path, handlers});
    },
    post(path, ...handlers) {
      routes.push({method: "POST", path, handlers});
    },
    put(path, ...handlers) {
      routes.push({method: "PUT", path, handlers});
    },
    use(path, ...handlers) {
      routes.push({method: "USE", path, handlers});
    },
    routes,
  };
  return app;
}

function createResponse() {
  return {
    body: null,
    statusCode: 200,
    headers: {},
    json(body) {
      this.body = body;
      return this;
    },
    redirect(location) {
      this.headers.location = location;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    type(value) {
      this.headers.type = value;
      return this;
    },
  };
}

test("browser routes retain browser middleware and terminal response contract", async () => {
  const app = createFakeApp();
  registerBrowserRoutes({
    activity: {updateSessionActivity: async () => {}},
    admin: {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    app,
    browserVncWebSocketPath: () => "/browser/vnc",
    chromeRuntime: {status: () => ({enabled: false})},
    config: {
      chromeEnabled: false,
      previewEnabled: false,
      runnerCapabilities: {terminal: true},
      workspaceId: "workspace-1",
      sessionId: "session-1",
      bucketName: "bucket",
      prefix: "prefix",
    },
    expressStatic: () => () => {},
    preview: {capabilityStatus: () => ({enabled: false})},
    requireBrowserAccess: (req, res, next) => {
      req.mapacheAccessToken = "signed-token";
      next();
    },
    requireBrowserOrRunnerAccess: (req, res, next) => next(),
    renderTerminalPage: ({accessToken}) => `<html data-token="${accessToken}"></html>`,
  });

  const route = app.routes.find(({method, path}) => method === "GET" && path === "/");
  const req = {};
  const res = createResponse();
  let nextCalled = false;
  route.handlers[0](req, res, () => {
    nextCalled = true;
  });
  route.handlers[1](req, res);

  assert.equal(nextCalled, true);
  assert.equal(res.headers.type, "html");
  assert.equal(res.body, `<html data-token="signed-token"></html>`);

  const shellRoute = app.routes.find(({method, path}) => method === "GET" && path === "/shell");
  const shellResponse = createResponse();
  shellRoute.handlers[0]({}, shellResponse, () => {});
  shellRoute.handlers[1]({mapacheAccessToken: "signed-token"}, shellResponse);
  assert.equal(shellResponse.body, `<html data-token="signed-token"></html>`);
});

test("health route exposes checkpoint status without runner error details", async () => {
  const app = createFakeApp();
  registerBrowserRoutes({
    activity: {updateSessionActivity: async () => {}},
    admin: {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    app,
    browserVncWebSocketPath: () => "/browser/vnc",
    checkpointPublisher: {status: async () => ({
      lastCheckpointAt: "2026-09-11T12:00:00.000Z",
      checkpointError: "checkpoint_upload_failed",
      internal: "must-not-be-exposed",
    })},
    chromeRuntime: {status: () => ({enabled: false})},
    config: {
      chromeEnabled: false,
      previewEnabled: false,
      runnerCapabilities: {terminal: true},
      workspaceId: "workspace-1",
      sessionId: "session-1",
      bucketName: "bucket",
      prefix: "prefix",
    },
    expressStatic: () => () => {},
    preview: {capabilityStatus: () => ({enabled: false})},
    requireBrowserAccess: (req, res, next) => next(),
    requireBrowserOrRunnerAccess: (req, res, next) => next(),
    renderTerminalPage: () => "",
  });
  const route = app.routes.find(({method, path}) => method === "GET" && path === "/runner/health");
  const response = createResponse();
  const request = {};
  route.handlers[0](request, response, () => {});
  await route.handlers[1](request, response);
  assert.deepEqual(response.body, {
    ok: true,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    bucketName: "bucket",
    prefix: "prefix",
    lastCheckpointAt: "2026-09-11T12:00:00.000Z",
    checkpointError: "checkpoint_upload_failed",
  });
});

test("health route exposes safe managed-agent activity without browser sockets", async () => {
  const app = createFakeApp();
  registerBrowserRoutes({
    activity: {updateSessionActivity: async () => {}},
    admin: {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    app,
    browserVncWebSocketPath: () => "/browser/vnc",
    checkpointPublisher: {status: async () => ({})},
    chromeRuntime: {status: () => ({enabled: false})},
    config: {
      chromeEnabled: false,
      previewEnabled: false,
      runnerCapabilities: {terminal: true},
      workspaceId: "workspace-1",
      sessionId: "session-1",
      bucketName: "bucket",
      prefix: "prefix",
    },
    expressStatic: () => () => {},
    piWebUi: {
      status: () => ({state: "ready", ready: true, pid: 42}),
      activity: async () => ({ok: true, connectedClients: 0, activeConversations: 1, activeTools: 1, pendingMessages: 0}),
    },
    preview: {capabilityStatus: () => ({enabled: false})},
    requireBrowserAccess: (req, res, next) => next(),
    requireBrowserOrRunnerAccess: (req, res, next) => next(),
    renderTerminalPage: () => "",
  });
  const route = app.routes.find(({method, path}) => method === "GET" && path === "/runner/health");
  const response = createResponse();
  await route.handlers[1]({}, response);

  assert.deepEqual(response.body.agentActivity, {
    ok: true,
    connectedClients: 0,
    activeConversations: 1,
    activeTools: 1,
    pendingMessages: 0,
  });
  assert.deepEqual(response.body.agentRuntime, {state: "ready", ready: true, pid: 42});
});

test("workspace routes keep runner-only sync-down protection and response code", async () => {
  const app = createFakeApp();
  registerWorkspaceRoutes({
    app,
    hasRunnerAccess: () => false,
    shutdown: async () => {},
    workspaceSync: {syncDown: async () => {}, syncUp: async () => {}},
  });

  const route = app.routes.find(({method, path}) => method === "POST" && path === "/workspace/sync-down");
  const res = createResponse();
  await route.handlers[0]({}, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {error: "not_found"});
});

test("Google MCP status route requires runner access and returns safe status", async () => {
  const app = createFakeApp();
  registerGoogleMcpRoutes({
    app,
    googleMcpStatus: () => ({ok: true, supported: true, servers: []}),
    hasRunnerAccess: (req) => req.authorized === true,
  });
  const route = app.routes.find(({method, path}) => method === "GET" && path === "/google/mcp/status");
  const unauthorized = createResponse();
  await route.handlers[0]({authorized: false}, unauthorized);
  assert.equal(unauthorized.statusCode, 404);
  const authorized = createResponse();
  await route.handlers[0]({authorized: true}, authorized);
  assert.deepEqual(authorized.body, {ok: true, supported: true, servers: []});
});

test("canonical health endpoint requires authentication and reserved aliases do not exist", async (t) => {
  const express = require("express");
  const app = express();
  const gate = (req, res, next) => req.get("x-shutdown-token") === "test-token" ?
    next() : res.status(404).end();
  registerBrowserRoutes({
    app, config: {workspaceId: "workspace-1", sessionId: "session-1"},
    requireBrowserAccess: gate, requireBrowserOrRunnerAccess: gate,
    checkpointPublisher: {status: async () => ({lastCheckpointAt: "saved"})},
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + "/runner/health")).status, 404);
  const headers = {"x-shutdown-token": "test-token"};
  const response = await fetch(origin + "/runner/health", {headers});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).lastCheckpointAt, "saved");
  for (const route of ["/healthz", "/healthz/"]) {
    assert.equal((await fetch(origin + route, {headers})).status, 404);
  }
});
