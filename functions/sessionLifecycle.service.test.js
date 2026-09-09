"use strict";

const assert = require("assert");
const {createSessionLifecycleService} = require("./sessionLifecycle.service");

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
const lifecycle = createSessionLifecycleService({
  admin,
  deleteSessionService: async (...args) => {
    calls.push({kind: "deleteService", args});
    return true;
  },
  normalizeRequestedSessionResources: () => ({cpu: "2", memory: "2Gi"}),
  patchSessionService: async (...args) => calls.push({kind: "patchService", args}),
  prepareSessionForProvisioning: async (session) => ({...session, prepared: true}),
  provisionSessionService: async (...args) => calls.push({kind: "provisionService", args}),
  requireWorkspace: async () => workspace,
  reserveChromeWorkspaceSession: async (...args) => {
    calls.push({kind: "reserveChrome", args});
    return {syncWriterRole: "writer", syncWriterLeaseId: "chrome-lease"};
  },
  reserveWorkspaceSyncSession: async (...args) => {
    calls.push({kind: "reserveSync", args});
    return {syncWriterRole: "writer", syncWriterLeaseId: "workspace-lease"};
  },
  releaseWorkspaceSyncWriterLease: async (...args) => calls.push({kind: "releaseSync", args}),
  sessionCollection: () => ({doc: () => sessionRef}),
});

(async () => {
  currentSession = {ownerUid: "user-1", status: "running", serviceUrl: "https://runner", shutdownToken: "token", resources: {cpu: "1"}};
  const lookedUp = await lifecycle.requireSession("user-1", "workspace-1", "session-1");
  assert.strictEqual(lookedUp.sessionRef, sessionRef);
  await assert.rejects(
      lifecycle.requireSession("other-user", "workspace-1", "session-1"),
      (error) => error.status === 403 && error.publicMessage === "session_forbidden",
  );

  calls.length = 0;
  currentSession = {ownerUid: "user-1", name: "Old name", status: "running"};
  const renamed = await lifecycle.renameSession("user-1", "workspace-1", "session-1", {name: "  New name  "});
  assert.strictEqual(renamed.name, "New name");
  assert.strictEqual(currentSession.name, "New name");
  assert.deepStrictEqual(calls.map((call) => call.kind), ["update"]);
  await assert.rejects(
      lifecycle.renameSession("user-1", "workspace-1", "session-1", {name: "   "}),
      (error) => error.status === 400 && error.publicMessage === "invalid_session_name",
  );

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
    serviceUrl: null,
    shutdownToken: "token",
    browserAccessTokenSecret: "secret",
    syncWriterRole: "none",
    sourceType: "github",
    sourceMode: "connected",
    sourceRepoUrl: "https://github.com/example/stale.git",
    syncPolicyMode: "github-cache",
    syncPolicyExclude: [".git/"],
  };
  await lifecycle.restartSession("user-1", "workspace-1", "session-1");
  assert.strictEqual(currentSession.status, "provisioning");
  assert.strictEqual(calls.some((call) => call.kind === "reserveSync"), true);
  assert.strictEqual(calls.some((call) => call.kind === "provisionService"), true);
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncWriterRole, "writer");
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncWriterLeaseId, "workspace-lease");
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].sourceType, "blank");
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].sourceMode, null);
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].sourceRepoUrl, null);
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncPolicyMode, "blank");
  assert.deepStrictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncPolicyExclude, []);

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
    capabilities: {terminal: true, preview: true, previewQa: true, functions: true, n64: false, chrome: true},
    syncWriterRole: "none",
  };
  await lifecycle.restartSession("user-1", "workspace-1", "session-1");
  assert.strictEqual(calls.some((call) => call.kind === "reserveChrome"), true);
  assert.strictEqual(calls.some((call) => call.kind === "reserveSync"), false);
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncWriterRole, "writer");
  assert.strictEqual(calls.find((call) => call.kind === "provisionService").args[2].syncWriterLeaseId, "chrome-lease");
  assert.strictEqual(currentSession.capabilities.chat, true);

  calls.length = 0;
  currentSession = {ownerUid: "user-1", status: "running", serviceUrl: "https://runner", shutdownToken: "token"};
  assert.deepStrictEqual(await lifecycle.stopSession("user-1", "workspace-1", "session-1"), {id: "session-1", ...currentSession});
  assert.strictEqual(calls.some((call) => call.kind === "deleteService"), true);

  currentSession = {ownerUid: "user-1", status: "running", serviceUrl: "https://runner", shutdownToken: "token"};
  assert.deepStrictEqual(await lifecycle.deleteSession("user-1", "workspace-1", "session-1"), {ok: true});
  assert.strictEqual(calls.some((call) => call.kind === "delete"), true);

  console.log("session lifecycle service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
