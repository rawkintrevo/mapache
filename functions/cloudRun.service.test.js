"use strict";

const assert = require("assert");
const {
  buildCloudRunPatch,
  buildCloudRunService,
  codexHomeDir,
  codexHomeStoragePrefix,
  createCloudRunService,
  homeStoragePrefix,
  normalizeResources,
  piSessionDir,
  piSessionStoragePrefix,
  requireRunnerServiceAccount,
  resourceLimits,
  runnerServiceAccountValue,
  sessionRunnerEnv,
  stringifySyncPolicyExclude,
  terminalCommandEnv,
} = require("./cloudRun.service");

function envMap(env) {
  return env.reduce((acc, entry) => {
    acc[entry.name] = entry.value;
    return acc;
  }, {});
}

assert.strictEqual(
    runnerServiceAccountValue({
      envValue: "Mapache-Runner@Pi-Agents-Cloud.iam.gserviceaccount.com",
      paramValue: "",
    }),
    "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com",
);
assert.strictEqual(
    requireRunnerServiceAccount({
      serviceAccount: "fallback-runner@pi-agents-cloud.iam.gserviceaccount.com",
    }, {
      envValue: "",
      paramValue: "",
    }),
    "fallback-runner@pi-agents-cloud.iam.gserviceaccount.com",
);
assert.throws(
    () => requireRunnerServiceAccount({}, {envValue: "", paramValue: ""}),
    /Set SESSION_RUNNER_SERVICE_ACCOUNT/,
);

assert.deepStrictEqual(normalizeResources({cpu: "2", memory: "2Gi"}), {
  cpu: "2",
  memory: "2Gi",
});
assert.deepStrictEqual(normalizeResources({}), {
  cpu: "1",
  memory: "1Gi",
});
assert.deepStrictEqual(resourceLimits({cpu: "2", memory: "512Mi"}), {
  cpu: "2",
  memory: "512Mi",
});

assert.strictEqual(codexHomeDir("session-1"), "/tmp/mapache-codex/session-1");
assert.strictEqual(codexHomeStoragePrefix("workspaces/u/w", "session-1"), "workspaces/u/w/.mapache-internal/codex-home");
assert.strictEqual(homeStoragePrefix("workspaces/u/w"), "workspaces/u/w/.mapache-internal/home");
assert.strictEqual(piSessionDir("session-1"), "/root/.pi/agent/mapache-sessions/session-1");
assert.strictEqual(piSessionDir("session-1", "/home/mapache"), "/home/mapache/.pi/agent/mapache-sessions/session-1");
assert.strictEqual(piSessionStoragePrefix("workspaces/u/w", "session-1"), "workspaces/u/w/.mapache-internal/sessions/session-1/pi-session");
assert.strictEqual(stringifySyncPolicyExclude([".git/", "node_modules/"]), "[\".git/\",\"node_modules/\"]");
assert.strictEqual(stringifySyncPolicyExclude("bad"), "[]");

assert.deepStrictEqual(terminalCommandEnv({terminalKind: "shell"}), {
  command: "bash",
  args: ["-l"],
});
assert.deepStrictEqual(terminalCommandEnv({
  terminalKind: "pi",
  piSessionDir: "/root/.pi/agent/mapache-sessions/session-1",
}), {
  command: "pi",
  args: ["--session-dir", "/root/.pi/agent/mapache-sessions/session-1", "-c"],
});
assert.deepStrictEqual(terminalCommandEnv({terminalKind: "codex"}), {
  command: "codex",
  args: [],
});
assert.deepStrictEqual(terminalCommandEnv({terminalKind: "ssh"}), {
  command: "",
  args: [],
});

(async () => {
  const originalProject = process.env.GCLOUD_PROJECT;
  const originalRunnerServiceAccount = process.env.SESSION_RUNNER_SERVICE_ACCOUNT;
  process.env.GCLOUD_PROJECT = "pi-agents-cloud";
  const shellEnv = envMap(await sessionRunnerEnv({
    ownerUid: "uid-1",
    workspaceId: "workspace-1",
    runnerSessionId: "session-1",
    workspaceStorageBucket: "bucket-1",
    workspaceStoragePrefix: "workspaces/uid-1/demo",
    terminalKind: "shell",
    name: "Shell",
    shutdownToken: "shutdown",
    browserAccessTokenSecret: "browser-secret",
    homeDir: "/root",
    homeStorageBucket: "bucket-1",
    homeStoragePrefix: "workspaces/uid-1/demo/.mapache-internal/home",
    workspaceEnv: {FOO: "workspace", SHARED: "workspace"},
    sessionEnv: {SHARED: "session"},
    mcpConfig: {mcpServers: {demo: {command: "node", args: ["server.js"]}}},
    capabilities: {terminal: true, preview: false, previewQa: false, functions: false, n64: false},
  }));
  assert.strictEqual(shellEnv.FIREBASE_PROJECT_ID, "pi-agents-cloud");
  assert.strictEqual(shellEnv.HOME, "/root");
  assert.strictEqual(shellEnv.HOME_STORAGE_PREFIX, "workspaces/uid-1/demo/.mapache-internal/home");
  assert.strictEqual(shellEnv.FOO, "workspace");
  assert.strictEqual(shellEnv.SHARED, "session");
  assert.strictEqual(shellEnv.TERMINAL_COMMAND, "bash");
  assert.strictEqual(shellEnv.TERMINAL_ARGS, "[\"-l\"]");
  assert.deepStrictEqual(JSON.parse(shellEnv.MCP_CONFIG), {
    version: 1,
    mcpServers: {demo: {command: "node", args: ["server.js"]}},
  });
  assert.strictEqual(shellEnv.RUNNER_CAPABILITIES, "{\"terminal\":true,\"preview\":false,\"previewQa\":false,\"functions\":false,\"n64\":false}");

  const previewEnv = envMap(await sessionRunnerEnv({
    ownerUid: "uid-1",
    workspaceId: "workspace-1",
    runnerSessionId: "session-1",
    workspaceStorageBucket: "bucket-1",
    workspaceStoragePrefix: "workspaces/uid-1/demo",
    terminalKind: "pi",
    capabilities: {terminal: true, preview: true, previewQa: true, functions: true, n64: false},
  }));
  assert.strictEqual(previewEnv.TERMINAL_COMMAND, "pi");
  assert.strictEqual(previewEnv.PI_CODING_AGENT_DIR, "/root/.pi/agent");
  assert.strictEqual(previewEnv.PREVIEW_ENABLED, "true");
  assert.strictEqual(previewEnv.PREVIEW_STATIC_ROOT, "/workspace/build");
  assert.strictEqual(previewEnv.MAPACHE_PREVIEW_URL, "http://127.0.0.1:8080/preview/");

  const codexEnv = envMap(await sessionRunnerEnv({
    ownerUid: "uid-1",
    workspaceId: "workspace-1",
    runnerSessionId: "session-1",
    workspaceStorageBucket: "bucket-1",
    workspaceStoragePrefix: "workspaces/uid-1/demo",
    terminalKind: "codex",
    capabilities: {terminal: true, preview: false, previewQa: false, functions: false, n64: false},
  }));
  assert.strictEqual(codexEnv.TERMINAL_COMMAND, "codex");
  assert.strictEqual(codexEnv.CODEX_HOME, "/tmp/mapache-codex/session-1");
  assert.strictEqual(codexEnv.CODEX_HOME_STORAGE_PREFIX, "workspaces/uid-1/demo/.mapache-internal/codex-home");

  const githubEnv = envMap(await sessionRunnerEnv({
    ownerUid: "uid-1",
    workspaceId: "workspace-1",
    runnerSessionId: "session-1",
    workspaceStoragePrefix: "workspaces/uid-1/demo",
    terminalKind: "pi",
    sourceType: "github",
    sourceMode: "connected",
    sourceRepoUrl: "https://github.com/rawkintrevo/mapache.git",
    sourceRepoOwner: "rawkintrevo",
    sourceRepoName: "mapache",
    sourceRequestedBranch: "main",
    sourceResolvedBranch: "main",
    capabilities: {terminal: true, preview: false, previewQa: false, functions: false, n64: false},
  }, {}, {
    buildGithubAuthEnv: async () => [
      {name: "GITHUB_AUTOMATION_USERNAME", value: "x-access-token"},
      {name: "GITHUB_AUTOMATION_TOKEN", value: "token"},
    ],
  }));
  assert.strictEqual(githubEnv.GITHUB_REPO_OWNER, "rawkintrevo");
  assert.strictEqual(githubEnv.GITHUB_CHECKOUT_REF, "main");
  assert.strictEqual(githubEnv.GITHUB_AUTOMATION_TOKEN, "token");

  process.env.SESSION_RUNNER_SERVICE_ACCOUNT = "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com";
  const service = await buildCloudRunService({
    id: "workspace-1",
    bucket: "bucket-1",
    storagePrefix: "workspaces/uid-1/demo",
  }, {
    ownerUid: "uid-1",
    runnerSessionId: "session-1",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest",
    resources: {cpu: "1", memory: "1Gi"},
    terminalKind: "shell",
    shutdownToken: "shutdown",
    browserAccessTokenSecret: "browser-secret",
    capabilities: {terminal: true, preview: false, previewQa: false, functions: false, n64: false},
  });
  assert.strictEqual(service.template.serviceAccount, "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com");
  assert.strictEqual(service.template.scaling.maxInstanceCount, 1);
  assert.strictEqual(service.template.containers[0].resources.limits.cpu, "1");
  assert.strictEqual(envMap(service.template.containers[0].env).WORKSPACE_ID, "workspace-1");

  const patch = await buildCloudRunPatch({
    serviceAccount: "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest",
    resources: {cpu: "2", memory: "2Gi"},
    terminalKind: "shell",
    capabilities: {terminal: true, preview: false, previewQa: false, functions: false, n64: false},
  }, {restart: true});
  assert.strictEqual(patch.template.containers[0].resources.limits.memory, "2Gi");
  assert.ok(envMap(patch.template.containers[0].env).RESTART_NONCE);

  let operationPolls = 0;
  const delayedUpdates = [];
  const delayedClient = {
    request: async ({url, method}) => {
      if (method === "POST" && url.includes("/services?serviceId=")) {
        return {data: {name: "operations/delayed-create"}};
      }
      if (method === "GET" && url.endsWith("operations/delayed-create")) {
        operationPolls += 1;
        return {data: {done: operationPolls === 31}};
      }
      if (method === "POST" && url.endsWith(":setIamPolicy")) return {data: {}};
      if (method === "GET" && url.includes("/services/session-delayed")) {
        return {data: {uri: "https://session-delayed.example.run.app"}};
      }
      throw new Error(`Unexpected delayed provisioning request: ${method} ${url}`);
    },
  };
  const delayedService = createCloudRunService({
    auth: {getClient: async () => delayedClient},
    operationTimeoutMs: 62000,
    operationPollIntervalMs: 2000,
    sleep: async () => {},
  });
  await delayedService.provisionSessionService({
    id: "workspace-1",
    bucket: "bucket-1",
    storagePrefix: "workspaces/uid-1/demo",
  }, {
    update: async (update) => delayedUpdates.push(update),
  }, {
    ownerUid: "uid-1",
    workspaceId: "workspace-1",
    runnerSessionId: "delayed",
    serviceId: "session-delayed",
    region: "us-central1",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest",
    resources: {cpu: "1", memory: "1Gi"},
    terminalKind: "shell",
    serviceAccount: "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com",
    capabilities: {terminal: true, preview: false},
  });
  assert.strictEqual(operationPolls, 31);
  assert.strictEqual(delayedUpdates.length, 1);
  assert.strictEqual(delayedUpdates[0].status, "running");
  assert.strictEqual(delayedUpdates[0].serviceUrl, "https://session-delayed.example.run.app");

  const reconciledUpdates = [];
  const reconciledClient = {
    request: async ({url, method}) => {
      if (method === "POST" && url.includes("/services?serviceId=")) {
        return {data: {name: "operations/reconciled-create"}};
      }
      if (method === "GET" && url.endsWith("operations/reconciled-create")) {
        return {data: {done: false}};
      }
      if (method === "GET" && url.includes("/services/session-reconciled")) {
        return {data: {
          uri: "https://session-reconciled.example.run.app",
          terminalCondition: {state: "CONDITION_SUCCEEDED"},
        }};
      }
      if (method === "POST" && url.endsWith(":setIamPolicy")) return {data: {}};
      throw new Error(`Unexpected reconciled provisioning request: ${method} ${url}`);
    },
  };
  const reconciledService = createCloudRunService({
    auth: {getClient: async () => reconciledClient},
    operationTimeoutMs: 2000,
    operationPollIntervalMs: 2000,
    sleep: async () => {},
  });
  await reconciledService.provisionSessionService({
    id: "workspace-1",
    bucket: "bucket-1",
    storagePrefix: "workspaces/uid-1/demo",
  }, {
    update: async (update) => reconciledUpdates.push(update),
  }, {
    ownerUid: "uid-1",
    workspaceId: "workspace-1",
    runnerSessionId: "reconciled",
    serviceId: "session-reconciled",
    region: "us-central1",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest",
    resources: {cpu: "1", memory: "1Gi"},
    terminalKind: "shell",
    serviceAccount: "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com",
    capabilities: {terminal: true, preview: false},
  });
  assert.strictEqual(reconciledUpdates.length, 1);
  assert.strictEqual(reconciledUpdates[0].status, "running");
  assert.strictEqual(reconciledUpdates[0].serviceUrl, "https://session-reconciled.example.run.app");

  const timeoutRequests = [];
  const timeoutUpdates = [];
  const timeoutClient = {
    request: async ({url, method}) => {
      timeoutRequests.push({url, method});
      if (method === "POST" && url.includes("/services?serviceId=")) {
        return {data: {name: "operations/stuck-create"}};
      }
      if (method === "GET" && url.endsWith("operations/stuck-create")) {
        return {data: {done: false}};
      }
      if (method === "GET" && url.includes("/services/session-stuck")) {
        return {data: {terminalCondition: {state: "CONDITION_PENDING"}}};
      }
      if (method === "DELETE" && url.includes("/services/session-stuck")) {
        return {data: {name: "operations/delete-stuck"}};
      }
      throw new Error(`Unexpected timed-out provisioning request: ${method} ${url}`);
    },
  };
  const timeoutService = createCloudRunService({
    auth: {getClient: async () => timeoutClient},
    operationTimeoutMs: 4000,
    operationPollIntervalMs: 2000,
    sleep: async () => {},
  });
  await timeoutService.provisionSessionService({
    id: "workspace-1",
    bucket: "bucket-1",
    storagePrefix: "workspaces/uid-1/demo",
  }, {
    update: async (update) => timeoutUpdates.push(update),
  }, {
    ownerUid: "uid-1",
    workspaceId: "workspace-1",
    runnerSessionId: "stuck",
    serviceId: "session-stuck",
    region: "us-central1",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest",
    resources: {cpu: "1", memory: "1Gi"},
    terminalKind: "shell",
    serviceAccount: "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com",
    capabilities: {terminal: true, preview: false},
  });
  assert.ok(timeoutRequests.some(({method, url}) =>
    method === "DELETE" && url.includes("/services/session-stuck")));
  assert.strictEqual(timeoutUpdates.length, 1);
  assert.strictEqual(timeoutUpdates[0].status, "provision_failed");
  assert.match(timeoutUpdates[0].lastError, /timed out after 4000ms/);

  if (originalProject === undefined) delete process.env.GCLOUD_PROJECT;
  else process.env.GCLOUD_PROJECT = originalProject;
  if (originalRunnerServiceAccount === undefined) delete process.env.SESSION_RUNNER_SERVICE_ACCOUNT;
  else process.env.SESSION_RUNNER_SERVICE_ACCOUNT = originalRunnerServiceAccount;

  console.log("cloud run service tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
