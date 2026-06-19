"use strict";

const assert = require("assert");
const {
  ROUTE_DISPATCHERS,
  dispatchApiRoute,
  findRouteDispatcher,
} = require("./apiDispatch.helpers");
const {ROUTE_METHODS} = require("./apiRoutes.helpers");

const dispatcherEntries = Object.values(ROUTE_DISPATCHERS).flat();
assert(dispatcherEntries.length > 30, "expected route dispatcher coverage");

for (const [method, routeName] of dispatcherEntries) {
  assert.strictEqual(Boolean(findRouteDispatcher(method, routeName)), true, `${method} ${routeName}`);
  assert((ROUTE_METHODS[routeName] || []).includes(method), `${routeName} declares ${method}`);
}

assert.strictEqual(findRouteDispatcher("GET", "unknown"), null);
assert.strictEqual(findRouteDispatcher("PATCH", "workspaces"), null);

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
  await dispatchApiRoute({
    route,
    req: {method, body, query},
    res,
    user: {uid: "user-1"},
    handlers,
  });
  assert.strictEqual(calls.length, 1);
  return calls[0];
}

(async () => {
  assert.deepStrictEqual(await collectDispatch({
    route: {name: "workspaces"},
  }), {
    status: 200,
    payload: {workspaces: {handler: "listWorkspaces", args: ["user-1"]}},
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "sessions", workspaceId: "workspace-1"},
    body: {name: "Session"},
  }), {
    status: 201,
    payload: {
      session: {
        handler: "createSession",
        args: ["user-1", "workspace-1", {name: "Session"}],
      },
    },
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "GET",
    route: {name: "adminUsers"},
    query: {pageSize: "10", cursor: "uid-1"},
  }), {
    status: 200,
    payload: {
      handler: "listAdminUsers",
      args: [{uid: "user-1"}, {pageSize: "10", cursor: "uid-1"}],
    },
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "adminUserWhitelist", uid: "uid-2"},
    body: {whitelisted: true},
  }), {
    status: 200,
    payload: {
      user: {
        handler: "setAdminUserWhitelist",
        args: [{uid: "user-1"}, "uid-2", true],
      },
    },
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "gitCommit", workspaceId: "workspace-1", sessionId: "session-1"},
    body: {message: "hello"},
  }), {
    status: 200,
    payload: {
      handler: "commitGit",
      args: ["user-1", "workspace-1", "session-1", {message: "hello"}],
    },
  });

  const sharePreview = await collectDispatch({
    method: "POST",
    route: {name: "sessionSharePreview", workspaceId: "workspace-1", sessionId: "session-1"},
  });
  assert.strictEqual(sharePreview.status, 200);
  assert.strictEqual(sharePreview.payload.handler, "shareSessionPreview");
  assert.deepStrictEqual(sharePreview.payload.args.slice(0, 3), ["user-1", "workspace-1", "session-1"]);
  assert.strictEqual(sharePreview.payload.args[3].method, "POST");

  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "openAiCodexDeviceCode", action: "complete"},
    body: {deviceCode: "abc"},
  }), {
    status: 200,
    payload: {
      handler: "completeOpenAiCodexDeviceCode",
      args: ["user-1", {deviceCode: "abc"}],
    },
  });

  assert.deepStrictEqual(await collectDispatch({
    route: {name: "githubConnection"},
  }), {
    status: 200,
    payload: {
      handler: "getGithubConnection",
      args: ["user-1"],
    },
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "githubDisconnect"},
  }), {
    status: 200,
    payload: {
      handler: "disconnectGithub",
      args: ["user-1"],
    },
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "GET",
    route: {name: "unknown"},
  }), {
    status: 404,
    payload: {error: "not_found"},
  });

  console.log("api dispatch helper tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
