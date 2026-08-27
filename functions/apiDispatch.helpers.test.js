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
assert(dispatcherEntries.length > 30, "expected route dispatcher coverage");

const dispatchedRouteNames = new Set(dispatcherEntries.map(([, routeName]) => routeName));
for (const routeName of Object.keys(ROUTE_METHODS)) {
  assert(
    dispatchedRouteNames.has(routeName) || SPECIAL_ROUTE_NAMES.includes(routeName),
    `${routeName} is declared without a dispatcher or special handler`,
  );
}

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

async function collectDispatcherDependencies(method, routeName) {
  const names = [];
  const dispatcher = findRouteDispatcher(method, routeName);
  assert(dispatcher, `${method} ${routeName} should have a dispatcher`);
  const handlers = new Proxy({}, {
    get(_target, prop) {
      names.push(prop);
      return async () => ({});
    },
  });
  await dispatcher({
    route: {
      name: routeName,
      uid: "user-2",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      provider: "anthropic",
      entryId: "entry-1",
      port: "5173",
      action: "start",
    },
    req: {method, body: {}, query: {}},
    res: {},
    user: {uid: "user-1"},
    handlers,
  });
  return [...new Set(names)];
}

function createTestApiHandlers() {
  const stub = async () => ({});
  const operationNames = [
    "userWithUsage", "listAdminUsers", "setAdminUserWhitelist", "syncWorkspaceFiles",
    "listSessions", "createSession", "renameSession", "resizeSession", "restartSession", "stopSession",
    "deleteSession", "createSessionAccessUrls", "shareSessionPreview", "listSshSessionFiles",
    "readSshSessionFile", "saveSshSessionFile", "listSshSessionForwards", "createSshSessionForward",
    "closeSshSessionForward", "getGitStatusSummary", "pullGit", "stageGit", "unstageGit",
    "commitGit", "pushGit", "openPullRequest",
  ];
  const operations = Object.fromEntries(operationNames.map((name) => [name, stub]));
  const service = new Proxy({}, {get: () => stub});
  return createApiHandlers({
    agentAuthService: service,
    environmentKeysService: service,
    openAiCodexAuthService: service,
    piModelsService: service,
    piPackagesService: service,
    workspaceAgentAssetsService: service,
    workspaceService: service,
    githubService: service,
    googleWorkspaceService: service,
    operations,
  });
}

(async () => {
  assert.deepStrictEqual(await collectDispatch({
    route: {name: "workspaces"},
  }), {
    status: 200,
    payload: {workspaces: {handler: "listWorkspaces", args: ["user-1"]}},
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "PATCH",
    route: {name: "workspace", workspaceId: "workspace-1"},
    body: {name: "Renamed workspace"},
  }), {
    status: 200,
    payload: {
      workspace: {
        handler: "renameWorkspace",
        args: ["user-1", "workspace-1", {name: "Renamed workspace"}],
      },
    },
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
    route: {name: "workspaceSyncFiles", workspaceId: "workspace-1"},
  }), {
    status: 200,
    payload: {
      handler: "syncWorkspaceFiles",
      args: ["user-1", "workspace-1"],
    },
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "workspaceCreateFile", workspaceId: "workspace-1"},
    body: {path: "src/App.jsx"},
  }), {
    status: 201,
    payload: {
      handler: "createWorkspaceFile",
      args: ["user-1", "workspace-1", {path: "src/App.jsx"}],
    },
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "workspaceCreateDirectory", workspaceId: "workspace-1"},
    body: {path: "src/components"},
  }), {
    status: 201,
    payload: {
      handler: "createWorkspaceDirectory",
      args: ["user-1", "workspace-1", {path: "src/components"}],
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
    method: "PATCH",
    route: {name: "session", workspaceId: "workspace-1", sessionId: "session-1"},
    body: {name: "Renamed"},
  }), {
    status: 200,
    payload: {
      session: {
        handler: "renameSession",
        args: ["user-1", "workspace-1", "session-1", {name: "Renamed"}],
      },
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
    route: {name: "googleCatalog"},
  }), {
    status: 200,
    payload: {handler: "listGoogleWorkspaceServices", args: []},
  });
  assert.deepStrictEqual(await collectDispatch({
    route: {name: "googleConnection", connectionId: "google-1"},
  }), {
    status: 200,
    payload: {handler: "getGoogleConnection", args: ["user-1", "google-1"]},
  });
  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "googleConnectionStart", workspaceId: "workspace-1"},
    body: {serviceKeys: ["drive"]},
  }), {
    status: 200,
    payload: {handler: "startGoogleConnection", args: ["user-1", "workspace-1", {serviceKeys: ["drive"]}]},
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "GET",
    route: {name: "sessionSubagents", workspaceId: "workspace-1", sessionId: "session-1"},
  }), {
    status: 200,
    payload: {
      handler: "listWorkspaceSubagents",
      args: ["user-1", "workspace-1", "session-1"],
    },
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "sessionSubagents", workspaceId: "workspace-1", sessionId: "session-1"},
    body: {name: "worker"},
  }), {
    status: 200,
    payload: {
      handler: "saveWorkspaceSubagent",
      args: ["user-1", "workspace-1", "session-1", {name: "worker"}],
    },
  });

  assert.deepStrictEqual(await collectDispatch({
    method: "POST",
    route: {name: "sessionSubagentDelete", workspaceId: "workspace-1", sessionId: "session-1"},
    body: {name: "worker"},
  }), {
    status: 200,
    payload: {
      handler: "deleteWorkspaceSubagent",
      args: ["user-1", "workspace-1", "session-1", {name: "worker"}],
    },
  });

  const registry = createTestApiHandlers();
  const dependencyChecks = [];
  for (const group of Object.values(ROUTE_DISPATCHERS)) {
    for (const [method, routeName] of group) {
      dependencyChecks.push({
        route: `${method} ${routeName}`,
        names: await collectDispatcherDependencies(method, routeName),
      });
    }
  }
  dependencyChecks.push({
    route: "POST openAiCodexDeviceCode complete",
    names: await (async () => {
      const names = [];
      const handlers = new Proxy({}, {
        get(_target, prop) {
          names.push(prop);
          return async () => ({});
        },
      });
      await findRouteDispatcher("POST", "openAiCodexDeviceCode")({
        route: {name: "openAiCodexDeviceCode", action: "complete"},
        req: {method: "POST", body: {}, query: {}},
        res: {},
        user: {uid: "user-1"},
        handlers,
      });
      return [...new Set(names)];
    })(),
  });
  for (const check of dependencyChecks) {
    for (const name of check.names) {
      assert.strictEqual(typeof registry[name], "function", `${check.route} requires ${name}`);
    }
  }

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
