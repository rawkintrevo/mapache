"use strict";

const assert = require("assert");
const {
  ROUTE_DISPATCHERS,
  dispatchApiRoute,
  findRouteDispatcher,
} = require("./apiDispatch.helpers");
const {createApiHandlers} = require("./apiHandlers.helpers");
const {ROUTE_METHODS} = require("./apiRoutes.helpers");
const {SPECIAL_ROUTE_NAMES} = require("./apiRouteManifest");

const dispatcherEntries = Object.values(ROUTE_DISPATCHERS).flat();
assert(dispatcherEntries.length > 20, "expected retained route dispatcher coverage");
const dispatchedRouteNames = new Set(dispatcherEntries.map(([, routeName]) => routeName));
for (const routeName of Object.keys(ROUTE_METHODS)) {
  assert(
    dispatchedRouteNames.has(routeName) || SPECIAL_ROUTE_NAMES.includes(routeName),
    `${routeName} is declared without a dispatcher or special handler`,
  );
}
for (const [method, routeName] of dispatcherEntries) {
  assert(findRouteDispatcher(method, routeName), `${method} ${routeName}`);
  assert((ROUTE_METHODS[routeName] || []).includes(method), `${routeName} declares ${method}`);
}

for (const obsoleteRoute of [
  "workspaceFiles", "workspaceFile", "workspaceCreateFile", "workspaceCreateDirectory",
  "workspaceFileDownloadUrl", "gitStatus", "gitOpenPr", "piModels", "piPackages",
  "sessionSkills", "sessionSubagents",
]) {
  assert.strictEqual(findRouteDispatcher("GET", obsoleteRoute), null, `${obsoleteRoute} retired`);
}

async function collectDispatch({route, method = "GET", body, query = {}}) {
  const calls = [];
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      calls.push({status: this.statusCode, payload});
    },
  };
  const handlers = new Proxy({}, {
    get(_target, prop) {
      return (...args) => ({handler: prop, args});
    },
  });
  await dispatchApiRoute({route, req: {method, body, query}, res, user: {uid: "user-1"}, handlers});
  assert.strictEqual(calls.length, 1);
  return calls[0];
}

function createTestApiHandlers() {
  const stub = async () => ({});
  const operations = Object.fromEntries([
    "userWithUsage", "listAdminUsers", "setAdminUserWhitelist", "listSessions", "createSession",
    "renameSession", "resizeSession", "restartSession", "stopSession", "deleteSession",
    "createSessionAccessUrls", "shareSessionPreview", "listSshSessionFiles", "readSshSessionFile",
    "saveSshSessionFile", "listSshSessionForwards", "createSshSessionForward", "closeSshSessionForward",
  ].map((name) => [name, stub]));
  const service = new Proxy({}, {get: () => stub});
  return createApiHandlers({
    agentAuthService: service,
    environmentKeysService: service,
    openAiCodexAuthService: service,
    qaFaultHarnessService: service,
    workspaceService: service,
    githubService: service,
    googleWorkspaceService: service,
    operations,
  });
}

(async () => {
  assert.deepStrictEqual(await collectDispatch({route: {name: "workspaces"}}), {
    status: 200,
    payload: {workspaces: {handler: "listWorkspaces", args: ["user-1"]}},
  });
  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "sessions", workspaceId: "workspace-1"},
    body: {name: "Session"},
  }), {
    status: 201,
    payload: {session: {handler: "createSession", args: ["user-1", "workspace-1", {name: "Session"}]}},
  });
  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "openAiCodexDeviceCode", action: "complete"},
    body: {deviceCode: "abc"},
  }), {
    status: 200,
    payload: {handler: "completeOpenAiCodexDeviceCode", args: ["user-1", {deviceCode: "abc"}]},
  });
  assert.deepStrictEqual(await collectDispatch({
    method: "GET",
    route: {name: "sshSessionFiles", workspaceId: "workspace-1", sessionId: "session-1"},
    query: {path: "/root"},
  }), {
    status: 200,
    payload: {handler: "listSshSessionFiles", args: ["user-1", "workspace-1", "session-1", "/root"]},
  });

  const registry = createTestApiHandlers();
  for (const [method, routeName] of dispatcherEntries) {
    const handlers = new Proxy({}, {
      get(_target, prop) {
        return async () => ({handler: prop});
      },
    });
    const dispatcher = findRouteDispatcher(method, routeName);
    await dispatcher({
      route: {name: routeName, workspaceId: "workspace-1", sessionId: "session-1", action: "start"},
      req: {method, body: {}, query: {}},
      res: {},
      user: {uid: "user-1"},
      handlers,
    });
  }
  assert.strictEqual(typeof registry.getWorkspaceMcpConfig, "function");
  assert.strictEqual(typeof registry.startOpenAiCodexDeviceCode, "function");
  assert.strictEqual(typeof registry.listSshSessionFiles, "function");
  console.log("api dispatch helper tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
