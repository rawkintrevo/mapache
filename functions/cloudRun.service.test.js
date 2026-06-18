"use strict";

const assert = require("assert");
const {
  buildCloudRunPatch,
  buildCloudRunService,
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

assert.strictEqual(homeStoragePrefix("workspaces/u/w"), "workspaces/u/w/.mapahce-internal/home");
assert.strictEqual(piSessionDir("session-1"), "/root/.pi/agent/mapache-sessions/session-1");
assert.strictEqual(piSessionDir("session-1", "/home/mapache"), "/home/mapache/.pi/agent/mapache-sessions/session-1");
assert.strictEqual(piSessionStoragePrefix("workspaces/u/w", "session-1"), "workspaces/u/w/.mapahce-internal/sessions/session-1/pi-session");
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
    homeStoragePrefix: "workspaces/uid-1/demo/.mapahce-internal/home",
    workspaceEnv: {FOO: "workspace", SHARED: "workspace"},
    sessionEnv: {SHARED: "session"},
    capabilities: {terminal: true, preview: false, previewQa: false, functions: false, n64: false},
  }));
  assert.strictEqual(shellEnv.FIREBASE_PROJECT_ID, "pi-agents-cloud");
  assert.strictEqual(shellEnv.HOME, "/root");
  assert.strictEqual(shellEnv.HOME_STORAGE_PREFIX, "workspaces/uid-1/demo/.mapahce-internal/home");
  assert.strictEqual(shellEnv.FOO, "workspace");
  assert.strictEqual(shellEnv.SHARED, "session");
  assert.strictEqual(shellEnv.TERMINAL_COMMAND, "bash");
  assert.strictEqual(shellEnv.TERMINAL_ARGS, "[\"-l\"]");
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

  if (originalProject === undefined) delete process.env.GCLOUD_PROJECT;
  else process.env.GCLOUD_PROJECT = originalProject;
  if (originalRunnerServiceAccount === undefined) delete process.env.SESSION_RUNNER_SERVICE_ACCOUNT;
  else process.env.SESSION_RUNNER_SERVICE_ACCOUNT = originalRunnerServiceAccount;

  console.log("cloud run service tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
