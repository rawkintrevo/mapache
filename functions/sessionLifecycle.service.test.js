"use strict";

const assert = require("assert");
const {createSessionLifecycleService, isIdleSession} = require("./sessionLifecycle.service");

const timestamp = {
  toDate: () => new Date("2026-01-01T00:00:00.000Z"),
  toMillis: () => Date.parse("2026-01-01T00:00:00.000Z"),
};
const admin = {
  firestore: {
    FieldValue: {
      delete: () => "DELETE_FIELD",
      serverTimestamp: () => "SERVER_TIMESTAMP",
    },
    Timestamp: {now: () => timestamp},
  },
};
const calls = [];
let currentSession;
const sessionRef = {
  id: "session-1",
  async get() {
    return {exists: Boolean(currentSession), id: this.id, data: () => currentSession};
  },
  async update(updates) {
    currentSession = {...currentSession, ...updates};
    calls.push({kind: "update", updates});
  },
  async delete() {
    currentSession = null;
    calls.push({kind: "delete"});
  },
};
const workspace = {source: {type: "blank"}, bucket: "bucket", storagePrefix: "workspaces/user-1/workspace-1", mcpConfig: {}};
let deleteServiceResult = true;
const lifecycle = createSessionLifecycleService({
  admin,
  deleteSessionService: async (...args) => {
    calls.push({kind: "deleteService", args});
    if (!deleteServiceResult) currentSession = {...currentSession, status: "stop_failed"};
    return deleteServiceResult;
  },
  normalizeRequestedSessionResources: () => ({cpu: "2", memory: "2Gi"}),
  patchSessionService: async (...args) => calls.push({kind: "patchService", args}),
  prepareSessionForProvisioning: async (session) => ({...session, prepared: true}),
  provisionSessionService: async (...args) => calls.push({kind: "provisionService", args}),
  requireWorkspace: async () => workspace,
  reserveChromeWorkspaceSession: async (...args) => {
    calls.push({kind: "reserveChrome", args});
    const session = args[2] || {};
    return {
      syncWriterRole: "writer",
      syncWriterLeaseId: "chrome-lease",
      ...(session.agentUiVersion ? {
        agentRuntimeGeneration: Number(session.agentRuntimeGeneration || 0) + 1,
        agentRuntimeState: "starting",
      } : {}),
    };
  },
  reserveWorkspaceSyncSession: async (...args) => {
    calls.push({kind: "reserveSync", args});
    return {syncWriterRole: "writer", syncWriterLeaseId: "workspace-lease"};
  },
  releaseWorkspaceSyncWriterLease: async (...args) => calls.push({kind: "releaseSync", args}),
  sessionCollection: () => ({doc: () => sessionRef}),
});

const minute = 60 * 1000;
const now = Date.parse("2026-01-01T02:00:00.000Z");
assert.strictEqual(isIdleSession({
  idleTimeoutMinutes: 60,
  lastActivityAt: now - 61 * minute,
  lastConnectedAt: now - minute,
  lastDisconnectedAt: now - 2 * minute,
}, now), true);
assert.strictEqual(isIdleSession({
  idleTimeoutMinutes: 60,
  lastActivityAt: now - 59 * minute,
  lastConnectedAt: now - 61 * minute,
}, now), false);
assert.strictEqual(isIdleSession({
  agentUiVersion: "pi-web-ui-v1",
  idleTimeoutMinutes: 60,
  lastActivityAt: now - 30 * minute,
  updatedAt: now - 2 * 60 * minute,
}, now), false);
assert.strictEqual(isIdleSession({
  agentUiVersion: "pi-web-ui-v1",
  idleTimeoutMinutes: 60,
  lastActivityAt: now - 2 * 60 * minute,
  runtimeStartedAt: now - 10 * minute,
  updatedAt: now - minute,
}, now), false);
assert.strictEqual(isIdleSession({
  agentUiVersion: "pi-web-ui-v1",
  idleTimeoutMinutes: 60,
  lastActivityAt: now - 2 * 60 * minute,
  runtimeStartedAt: now - 90 * minute,
  updatedAt: now - minute,
}, now), true);

(async () => {
  currentSession = {ownerUid: "user-1", status: "running", serviceUrl: "https://runner", shutdownToken: "token", resources: {cpu: "1"}};
  const lookedUp = await lifecycle.requireSession("user-1", "workspace-1", "session-1");
  assert.strictEqual(lookedUp.sessionRef, sessionRef);
  await assert.rejects(
      lifecycle.requireSession("other-user", "workspace-1", "session-1"),
      (error) => error.status === 403 && error.publicMessage === "session_forbidden",
  );

  calls.length = 0;
  currentSession = {
    ownerUid: "user-1",
    name: "Old name",
    status: "running",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
  };
  const renamed = await lifecycle.renameSession("user-1", "workspace-1", "session-1", {name: "  New name  "});
  assert.strictEqual(renamed.name, "New name");
  assert.strictEqual(currentSession.name, "New name");
  assert.deepStrictEqual(calls.map((call) => call.kind), ["update"]);
  await assert.rejects(
      lifecycle.renameSession("user-1", "workspace-1", "session-1", {name: "   "}),
      (error) => error.status === 400 && error.publicMessage === "invalid_session_name",
  );

  currentSession = {
    ownerUid: "user-1",
    status: "running",
    agentUiVersion: "pi-web-ui-v1",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
    longRunning: false,
  };
  const longRunningEnabled = await lifecycle.setSessionLongRunning("user-1", "workspace-1", "session-1", {enabled: true});
  assert.strictEqual(longRunningEnabled.longRunning, true);
  assert.strictEqual(currentSession.longRunning, true);
  const longRunningDisabled = await lifecycle.setSessionLongRunning("user-1", "workspace-1", "session-1", {enabled: false});
  assert.strictEqual(longRunningDisabled.longRunning, false);
  await assert.rejects(
      lifecycle.setSessionLongRunning("user-1", "workspace-1", "session-1", {enabled: "true"}),
      (error) => error.status === 400 && error.publicMessage === "invalid_long_running",
  );

  currentSession = {
    ownerUid: "user-1",
    status: "running",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
  };
  calls.length = 0;
  const resized = await lifecycle.resizeSession("user-1", "workspace-1", "session-1", {});
  assert.strictEqual(resized.id, "session-1");
  assert.strictEqual(currentSession.status, "resizing");
  assert.deepStrictEqual(calls.map((call) => call.kind), ["update", "patchService"]);

  calls.length = 0;
  currentSession = {
    ownerUid: "user-1",
    status: "stopped",
    terminalKind: "pi",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
    serviceUrl: null,
    capabilities: {chrome: true},
    shutdownToken: "token",
    browserAccessTokenSecret: "secret",
    syncWriterRole: "none",
    sourceType: "github",
    sourceMode: "connected",
    sourceRepoUrl: "https://github.com/example/stale.git",
    syncPolicyMode: "github-cache",
    syncPolicyExclude: [".git/"],
    workspaceStorageBucket: "stale-bucket",
    workspaceStoragePrefix: "workspaces/user-1/other-workspace",
  };
  await lifecycle.restartSession("user-1", "workspace-1", "session-1");
  assert.strictEqual(currentSession.status, "provisioning");
  assert.strictEqual(calls.some((call) => call.kind === "reserveChrome"), true);
  assert.strictEqual(calls.some((call) => call.kind === "reserveSync"), false);
  assert.strictEqual(calls.some((call) => call.kind === "provisionService"), true);
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncWriterRole, "writer");
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncWriterLeaseId, "chrome-lease");
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].sourceType, "blank");
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].sourceMode, null);
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].sourceRepoUrl, null);
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncPolicyMode, "blank");
  assert.deepStrictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncPolicyExclude, []);
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].workspaceStorageBucket, workspace.bucket);
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].workspaceStoragePrefix, workspace.storagePrefix);
  assert.strictEqual(currentSession.workspaceStoragePrefix, workspace.storagePrefix);

  calls.length = 0;
  currentSession = {
    ownerUid: "user-1",
    status: "stopped",
    terminalKind: "pi",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
    serviceUrl: null,
    shutdownToken: "token",
    browserAccessTokenSecret: "secret",
    capabilities: {terminal: true, preview: true, previewQa: true, functions: true, chrome: true},
    syncWriterRole: "none",
  };
  await lifecycle.restartSession("user-1", "workspace-1", "session-1");
  assert.strictEqual(calls.some((call) => call.kind === "reserveChrome"), true);
  assert.strictEqual(calls.some((call) => call.kind === "reserveSync"), false);
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncWriterRole, "writer");
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncWriterLeaseId, "chrome-lease");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(currentSession.capabilities, "chat"), false);

  calls.length = 0;
  currentSession = {
    ownerUid: "user-1",
    status: "running",
    serviceUrl: "https://runner",
    shutdownToken: "token",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
  };
  assert.deepStrictEqual(await lifecycle.stopSession("user-1", "workspace-1", "session-1"), {id: "session-1", ...currentSession});
  assert.strictEqual(calls.some((call) => call.kind === "deleteService"), true);

  currentSession = {ownerUid: "user-1", status: "running", serviceUrl: "https://runner", shutdownToken: "token"};
  assert.deepStrictEqual(await lifecycle.deleteSession("user-1", "workspace-1", "session-1"), {ok: true});
  assert.strictEqual(calls.some((call) => call.kind === "delete"), true);

  deleteServiceResult = false;
  currentSession = {
    ownerUid: "user-1",
    status: "running",
    serviceUrl: "https://runner",
    shutdownToken: "token",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
  };
  await assert.rejects(
      lifecycle.stopSession("user-1", "workspace-1", "session-1"),
      (error) => error.status === 502 && error.publicMessage === "session_stop_failed",
  );
  assert.strictEqual(currentSession.status, "stop_failed");
  await assert.rejects(
      lifecycle.restartSession("user-1", "workspace-1", "session-1"),
      (error) => error.status === 409 && error.publicMessage === "session_stop_failed",
  );
  deleteServiceResult = true;

  calls.length = 0;
  currentSession = {
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    status: "running",
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeGeneration: 3,
    terminalKind: "pi",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
    serviceName: "projects/p/locations/us-central1/services/session-1",
    serviceUrl: "https://runner.example",
    shutdownToken: "token",
    browserAccessTokenSecret: "secret",
    capabilities: {terminal: true, preview: true, previewQa: true, functions: true, chrome: true},
  };
  await lifecycle.restartSession("user-1", "workspace-1", "session-1");
  assert.deepStrictEqual(calls.filter((call) => ["deleteService", "reserveChrome", "provisionService"].includes(call.kind)).map((call) => call.kind), [
    "deleteService", "reserveChrome", "provisionService",
  ]);
  assert.strictEqual(calls.some((call) => call.kind === "patchService"), false);
  assert.strictEqual(currentSession.status, "provisioning");
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].agentRuntimeGeneration, 4);

  calls.length = 0;
  currentSession = {
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    status: "stop_failed",
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeGeneration: 4,
    agentRuntimeState: "stopping",
    terminalKind: "pi",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
    serviceName: "projects/p/locations/us-central1/services/session-1",
    serviceUrl: "https://runner.example",
    shutdownToken: "token",
    browserAccessTokenSecret: "secret",
    capabilities: {terminal: true, preview: true, previewQa: true, functions: true, chrome: true},
  };
  await lifecycle.restartSession("user-1", "workspace-1", "session-1");
  assert.deepStrictEqual(calls.filter((call) => ["deleteService", "reserveChrome", "provisionService"].includes(call.kind)).map((call) => call.kind), [
    "deleteService", "reserveChrome", "provisionService",
  ]);
  assert.strictEqual(currentSession.status, "provisioning");

  calls.length = 0;
  currentSession = {
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    status: "running",
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeGeneration: 4,
    terminalKind: "pi",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
    serviceName: "projects/p/locations/us-central1/services/session-1",
    serviceUrl: "https://runner.example",
    shutdownToken: "token",
    browserAccessTokenSecret: "secret",
    capabilities: {terminal: true, preview: true, previewQa: true, functions: true, chrome: true},
  };
  await lifecycle.resizeSession("user-1", "workspace-1", "session-1", {});
  assert.deepStrictEqual(calls.filter((call) => ["deleteService", "reserveChrome", "provisionService"].includes(call.kind)).map((call) => call.kind), [
    "deleteService", "reserveChrome", "provisionService",
  ]);
  assert.strictEqual(calls.some((call) => call.kind === "patchService"), false);
  assert.deepStrictEqual(calls.find((call) => call.kind === "provisionService").args[2].resources, {cpu: "2", memory: "2Gi"});

  for (const status of ["provision_failed", "update_failed", "stop_failed"]) {
    calls.length = 0;
    currentSession = {...currentSession, status, agentRuntimeGeneration: 4};
    await lifecycle.resizeSession("user-1", "workspace-1", "session-1", {});
    assert.deepStrictEqual(calls.filter((call) => ["deleteService", "reserveChrome", "provisionService"].includes(call.kind)).map((call) => call.kind), [
      "deleteService", "reserveChrome", "provisionService",
    ]);
    const provisioned = calls.find((call) => call.kind === "provisionService").args[2];
    assert.deepStrictEqual(provisioned.resources, {cpu: "2", memory: "2Gi"});
    assert.strictEqual(provisioned.agentRuntimeGeneration, 5);
    assert.strictEqual(currentSession.status, "provisioning");
  }

  deleteServiceResult = false;
  calls.length = 0;
  currentSession = {
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    status: "running",
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeGeneration: 5,
    terminalKind: "pi",
    imageKey: "pi-chrome",
    image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
    serviceName: "projects/p/locations/us-central1/services/session-1",
    serviceUrl: "https://runner.example",
    shutdownToken: "token",
    capabilities: {terminal: true, preview: true, previewQa: true, functions: true, chrome: true},
  };
  await assert.rejects(
      lifecycle.restartSession("user-1", "workspace-1", "session-1"),
      (error) => error.status === 502 && error.publicMessage === "session_stop_failed",
  );
  assert.strictEqual(calls.some((call) => call.kind === "provisionService"), false);
  deleteServiceResult = true;

  let reaperDeleted = 0;
  const reaperDocs = [
    {
      ref: {update: async () => { throw new Error("long-running runtime should be bypassed"); }},
      data: () => ({
        workspaceId: "workspace-1",
        agentUiVersion: "pi-web-ui-v1",
        longRunning: true,
        status: "running",
        activeSocketCount: 0,
        lastActivityAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
    },
    {
      ref: {update: async () => {}},
      data: () => ({
        workspaceId: "workspace-1",
        agentUiVersion: "pi-web-ui-v1",
        longRunning: false,
        status: "running",
        activeSocketCount: 0,
        lastActivityAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
    },
    {
      ref: {update: async () => { throw new Error("active runtime should not be reaped"); }},
      data: () => ({
        workspaceId: "workspace-1",
        agentUiVersion: "pi-web-ui-v1",
        longRunning: false,
        status: "running",
        activeSocketCount: 0,
        lastActivityAt: Date.now() - 5 * 60 * 1000,
      }),
    },
    {
      ref: {update: async () => {}},
      data: () => ({
        workspaceId: "workspace-1",
        status: "running",
        lastActivityAt: Date.now() - 2 * 60 * 60 * 1000,
      }),
    },
  ];
  const reaper = createSessionLifecycleService({
    admin,
    db: {
      collectionGroup: () => ({
        where: () => ({get: async () => ({docs: reaperDocs, size: reaperDocs.length})}),
      }),
    },
    deleteSessionService: async () => {
      reaperDeleted += 1;
      return true;
    },
  });
  const reaped = await reaper.reapIdleSessions();
  assert.deepStrictEqual(reaped, {
    checked: 4,
    eligible: 2,
    bypassed: 1,
    bypassedByReason: {long_running: 1},
    stopped: 2,
    failed: 0,
  });
  assert.strictEqual(reaperDeleted, 2);

  const automationReaperDoc = {
    id: "auto-run-1",
    ref: {update: async () => { throw new Error("admitted automation should be bypassed"); }},
    data: () => ({
      ownerUid: "user-1",
      workspaceId: "workspace-1",
      runtimeKind: "automation",
      automationRunId: "run-1",
      agentRuntimeAuthorityState: "admitted",
      status: "running",
      lastActivityAt: Date.now() - 2 * 60 * 60 * 1000,
    }),
  };
  const activeAutomationReaper = createSessionLifecycleService({
    admin,
    db: {
      collection: () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            id: "run-1",
            data: () => ({
              runId: "run-1",
              ownerUid: "user-1",
              workspaceId: "workspace-1",
              sessionId: "auto-run-1",
              status: "running",
              cleanupState: "pending",
            }),
          }),
        }),
      }),
      collectionGroup: () => ({
        where: () => ({get: async () => ({docs: [automationReaperDoc], size: 1})}),
      }),
    },
    deleteSessionService: async () => {
      throw new Error("admitted automation should not be deleted");
    },
  });
  assert.deepStrictEqual(await activeAutomationReaper.reapIdleSessions(), {
    checked: 1,
    eligible: 0,
    bypassed: 1,
    bypassedByReason: {automation_active_run: 1},
    stopped: 0,
    failed: 0,
  });

  const failedReaper = createSessionLifecycleService({
    admin,
    db: {
      collectionGroup: () => ({
        where: () => ({get: async () => ({
          docs: [
            {
              ref: {update: async () => {}},
              data: () => ({status: "running", lastActivityAt: Date.now() - 2 * 60 * 60 * 1000}),
            },
            {
              ref: {update: async () => { throw new Error("idle update failed"); }},
              data: () => ({status: "running", lastActivityAt: Date.now() - 2 * 60 * 60 * 1000}),
            },
          ],
          size: 2,
        })}),
      }),
    },
    deleteSessionService: async () => false,
  });
  const failedReaped = await failedReaper.reapIdleSessions();
  assert.deepStrictEqual(failedReaped, {
    checked: 2,
    eligible: 2,
    bypassed: 0,
    bypassedByReason: {},
    stopped: 0,
    failed: 2,
  });

  console.log("session lifecycle service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
