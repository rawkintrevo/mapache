"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {registerBrowserRoutes} = require("./browserPreviewRoutes");
const {registerWorkspaceRoutes} = require("./workspaceRoutes");

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
});

test("workspace routes keep runner-only sync-down protection and response code", async () => {
  const app = createFakeApp();
  registerWorkspaceRoutes({
    activity: {updateSessionActivity: async () => {}},
    admin: {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    app,
    chromeProfileSnapshots: {enabled: () => false},
    chromeRuntime: {stop: async () => {}},
    hasRunnerAccess: () => false,
    sshSession: {closeAll: () => {}},
    workspaceSync: {syncDown: async () => {}, syncUp: async () => {}},
  });

  const route = app.routes.find(({method, path}) => method === "POST" && path === "/workspace/sync-down");
  const res = createResponse();
  await route.handlers[0]({}, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {error: "not_found"});
});
