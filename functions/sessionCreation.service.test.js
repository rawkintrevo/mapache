"use strict";

const assert = require("assert");
const {createSessionCreationService} = require("./sessionCreation.service");
const {sessionRunnerEnv} = require("./cloudRun.service");
const {AGENT_UI_VERSION} = require("./agentRuntime.helpers");

const serverTimestamp = () => "SERVER_TIMESTAMP";
const admin = {firestore: {FieldValue: {serverTimestamp}}};
const reservations = [];
let storedSession = null;
let mainSession = null;
const sessionRef = {
  id: "operation-test-session",
  async get() {
    return storedSession ? {exists: true, id: this.id, data: () => storedSession} : {exists: false, id: this.id, data: () => ({})};
  },
};
const dependencies = {
  admin,
  db: {},
  normalizeRequestedSessionResources: () => ({cpu: "1", memory: "1Gi"}),
  releaseChromeWorkspaceSession: async (...args) => reservations.push({kind: "releaseChrome", args}),
  reserveChromeWorkspaceSession: async (...args) => {
    reservations.push({kind: "reserveChrome", args});
    storedSession = {...args[2], syncWriterRole: "writer"};
  },
  reserveGithubWorkspaceSession: async (...args) => {
    reservations.push({kind: "reserveGithub", args});
    storedSession = {...args[2], syncWriterRole: "writer"};
  },
  reserveWorkspaceSyncSession: async (...args) => {
    reservations.push({kind: "reserveSync", args});
    storedSession = {...args[2], syncWriterRole: "writer"};
  },
  resolveHarness: () => ({terminalKind: "pi"}),
  resolveRunnerImage: (payload) => {
    if (payload.imageKey !== "pi-chrome") throw Object.assign(new Error("invalid_runner_image"), {code: "invalid_runner_image"});
    return {
      key: payload.imageKey,
      imageKey: payload.imageKey,
      image: "gcr.io/example/chrome",
      harnessId: "pi",
      terminalKind: "pi",
      capabilities: {terminal: true, preview: true, chrome: true},
      canProvision: true,
    };
  },
  requireWorkspace: async (uid, workspaceId) => ({
    ownerUid: uid,
    id: workspaceId,
    bucket: "bucket",
    storagePrefix: `workspaces/${uid}/${workspaceId}`,
    source: {type: "blank"},
    mcpConfig: {},
  }),
  runnerServiceAccountValue: () => "runner@example.iam.gserviceaccount.com",
  sessionCollection: () => ({doc: (id) => id === "main-session" ? {
    get: async () => ({exists: mainSession !== null, data: () => mainSession}),
  } : ({...sessionRef, id})}),
};
const service = createSessionCreationService(dependencies);

async function createWithWorkspace(workspace, payload) {
  dependencies.requireWorkspace = async () => workspace;
  storedSession = null;
  reservations.length = 0;
  return service.createSession("user-1", "workspace-1", payload);
}

(async () => {
  const blank = await createWithWorkspace({
    ownerUid: "user-1",
    bucket: "bucket",
    storagePrefix: "workspaces/user-1/blank",
    source: {type: "blank"},
    mcpConfig: {},
  }, {operationId: "blank-1", name: "Blank"});
  assert.strictEqual(blank.sourceType, "blank");
  assert.strictEqual(blank.status, "provisioning");
  assert.strictEqual(blank.provisioningState, "queued");
  assert.strictEqual(blank.longRunning, false);
  assert.ok(blank.serviceId.length < 50);
  assert.strictEqual(reservations[0].kind, "reserveChrome");
  await assert.rejects(
      createWithWorkspace({
        ownerUid: "user-1",
        bucket: "bucket",
        storagePrefix: "workspaces/user-1/blank",
        source: {type: "blank"},
        mcpConfig: {},
      }, {operationId: "forged-image-key", imageKey: "codex-web"}),
      (error) => error.status === 400 && error.publicMessage === "invalid_runner_image",
  );
  await assert.rejects(
      createWithWorkspace({
        ownerUid: "user-1",
        bucket: "bucket",
        storagePrefix: "workspaces/user-1/blank",
        source: {type: "blank"},
        mcpConfig: {},
      }, {operationId: "forged-image-uri", image: "docker.io/attacker/runner:latest"}),
      (error) => error.status === 400 && error.publicMessage === "invalid_runner_image",
  );

  const github = await createWithWorkspace({
    ownerUid: "user-1",
    bucket: "bucket",
    storagePrefix: "workspaces/user-1/github",
    source: {type: "github", mode: "connected", owner: "octo", repo: "mapache", connection: {installationId: "42", repoId: "99"}},
    mcpConfig: {},
  }, {operationId: "github-1"});
  assert.strictEqual(github.sourceType, "github");
  assert.strictEqual(github.sourceMode, "connected");
  assert.strictEqual(github.sourceInstallationId, "42");
  assert.strictEqual(reservations[0].kind, "reserveChrome");

  const chrome = await createWithWorkspace({
    ownerUid: "user-1",
    bucket: "bucket",
    storagePrefix: "workspaces/user-1/chrome",
    source: {type: "blank"},
    mcpConfig: {},
  }, {operationId: "chrome-1", imageKey: "pi-chrome"});
  assert.strictEqual(chrome.capabilities.chrome, true);
  assert.strictEqual(reservations[0].kind, "reserveChrome");
  assert.strictEqual(reservations[0].args[3].syncWriterEligible, true);

  const marked = await createWithWorkspace({
    ownerUid: "user-1",
    agentUiVersion: AGENT_UI_VERSION,
    bucket: "bucket",
    storagePrefix: "workspaces/user-1/marked",
    source: {type: "blank"},
    mcpConfig: {},
  }, {operationId: "marked-1", imageKey: "pi-chrome", agentUiVersion: "browser-chosen-version"});
  assert.strictEqual(marked.agentUiVersion, AGENT_UI_VERSION);
  assert.strictEqual(marked.imageKey, "pi-chrome");
  assert.strictEqual(marked.harnessId, "pi");
  assert.strictEqual(marked.capabilities.chrome, true);
  assert.strictEqual(marked.longRunning, false);
  await assert.rejects(
      createWithWorkspace({
        ownerUid: "user-1",
        agentUiVersion: AGENT_UI_VERSION,
        source: {type: "blank"},
        mcpConfig: {},
      }, {operationId: "marked-unsupported-1", type: "ssh"}),
      (error) => error.status === 400 && error.publicMessage === "unsupported_session_type",
  );

  const automationSourceCheckpoint = {
    captureId: "source-capture",
    generation: 6,
    bootInstanceId: "main-boot",
    manifest: {bucketName: "bucket", objectPath: "agent-state/manifest.json", byteLength: 120, sha256: "a".repeat(64)},
  };
  const automation = await createWithWorkspace({
    ownerUid: "user-1",
    agentUiVersion: AGENT_UI_VERSION,
    canonicalSessionId: "main-session",
    agentRuntimeSessionId: "main-session",
    agentRuntimeCheckpoint: automationSourceCheckpoint,
    bucket: "bucket",
    storagePrefix: "workspaces/user-1/automation",
    source: {type: "blank"},
    mcpConfig: {},
  }, {
    operationId: "automation-operation",
    runtimeKind: "automation",
    runId: "run-123",
    name: "Daily Report",
    automationRunAt: "2026-09-22T20:40:50.000Z",
    automationTimezone: "America/Chicago",
  });
  assert.strictEqual(automation.id, "auto-run-123");
  assert.strictEqual(automation.runtimeKind, "automation");
  assert.strictEqual(automation.automationRunId, "run-123");
  assert.deepStrictEqual(automation.agentRuntimeSourceCheckpoint, automationSourceCheckpoint);
  assert.strictEqual(automation.agentRuntimeSourceSessionId, "main-session");
  assert.match(automation.serviceId, /^mpauto-[a-f0-9]{40}$/);
  assert.match(automation.automationStorage.output.agentPath,
      /^\/automations\/daily-report-2026-09-22-15-40-50-run123$/);
  assert.strictEqual(automation.longRunning, true);
  assert.strictEqual(reservations[0].args[3].singleRunner, false);

  const targetWorkspace = {
    ownerUid: "user-1", canonicalSessionId: "main-session", bucket: "bucket",
    storagePrefix: "workspaces/user-1/target", source: {type: "blank"},
    environmentEntryIds: ["workspace-default"],
  };
  const requestPayload = {
    runtimeKind: "automation", runId: "credential-run", operationId: "credential-run",
    environmentEntryIds: ["caller-entry"], authSelection: {harness: "pi", providers: {openai: "caller-provider"}},
  };
  mainSession = {
    ownerUid: "user-1", workspaceId: "workspace-1", status: "stopped",
    environmentEntryIds: ["hubspot-token", "apollo-token"],
    authSelection: {harness: "pi", providers: {openai: "target-provider"}},
    shutdownToken: "must-not-copy", transcript: "must-not-copy",
  };
  const inherited = await createWithWorkspace(targetWorkspace, requestPayload);
  assert.deepStrictEqual(inherited.environmentEntryIds, ["hubspot-token", "apollo-token"]);
  assert.deepStrictEqual(inherited.authSelection, mainSession.authSelection);
  assert.notStrictEqual(inherited.shutdownToken, mainSession.shutdownToken);
  assert.strictEqual(inherited.transcript, undefined);
  const runnerEnv = await sessionRunnerEnv(inherited, {}, {
    buildGenericEnvironmentEnv: async (session, ids) => {
      assert.strictEqual(session.ownerUid, "user-1");
      assert.deepStrictEqual(ids, ["hubspot-token", "apollo-token"]);
      return {HUBSPOT_ACCESS_TOKEN: "fresh-owner-store-value"};
    },
  });
  assert.ok(runnerEnv.some((entry) => entry.name === "HUBSPOT_ACCESS_TOKEN" &&
    entry.value === "fresh-owner-store-value"));
  assert.ok(!JSON.stringify(storedSession).includes("fresh-owner-store-value"));
  mainSession.environmentEntryIds = [];
  // A repeated create preserves the original selection instead of rewriting a live run.
  const repeated = await service.createSession("user-1", "workspace-1", requestPayload);
  assert.deepStrictEqual(repeated.environmentEntryIds, inherited.environmentEntryIds);
  mainSession.authSelection.providers = {};
  const cleared = await createWithWorkspace(targetWorkspace, requestPayload);
  assert.deepStrictEqual(cleared.environmentEntryIds, []);
  assert.deepStrictEqual(cleared.authSelection, {harness: "pi", providers: {}});
  delete mainSession.environmentEntryIds;
  delete mainSession.authSelection;
  mainSession.genericEnvironmentEntryIds = ["legacy-token"];
  const legacy = await createWithWorkspace(targetWorkspace, requestPayload);
  assert.deepStrictEqual(legacy.environmentEntryIds, ["legacy-token"]);
  assert.strictEqual(legacy.authSelection, undefined);
  delete mainSession.genericEnvironmentEntryIds;
  assert.deepStrictEqual((await createWithWorkspace(targetWorkspace, requestPayload)).environmentEntryIds,
      ["workspace-default"]);
  mainSession.ownerUid = "another-owner";
  await assert.rejects(createWithWorkspace(targetWorkspace, requestPayload),
      (error) => error.publicMessage === "automation_credential_source_forbidden");
  mainSession.ownerUid = "user-1";
  mainSession.workspaceId = "other-workspace";
  await assert.rejects(createWithWorkspace(targetWorkspace, requestPayload),
      (error) => error.publicMessage === "automation_credential_source_forbidden");
  mainSession.workspaceId = "workspace-1";
  mainSession.runtimeKind = "automation";
  await assert.rejects(createWithWorkspace(targetWorkspace, requestPayload),
      (error) => error.publicMessage === "automation_credential_source_forbidden");
  mainSession = null;
  assert.deepStrictEqual((await createWithWorkspace(targetWorkspace, requestPayload)).environmentEntryIds,
      ["workspace-default"]);
  assert.deepStrictEqual((await createWithWorkspace({...targetWorkspace, canonicalSessionId: null}, requestPayload))
      .environmentEntryIds, ["workspace-default"]);
  mainSession = {ownerUid: "user-1", environmentEntryIds: ["runtime-target"]};
  assert.deepStrictEqual((await createWithWorkspace({
    ...targetWorkspace, canonicalSessionId: null, agentRuntimeSessionId: "main-session",
  }, requestPayload)).environmentEntryIds, ["runtime-target"]);
  mainSession.authSelection = {harness: "pi", providers: {openai: {token: "must-not-copy"}}};
  await assert.rejects(createWithWorkspace(targetWorkspace, requestPayload),
      (error) => error.publicMessage === "automation_credential_selection_invalid");

  console.log("session creation service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
