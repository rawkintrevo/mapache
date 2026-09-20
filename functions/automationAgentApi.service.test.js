"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createAutomationAgentApiService} = require("./automationAgentApi.service");
const {createAutomationAgentAuthService} = require("./automationAgentAuth.service");

class Ref {
  constructor(value, id) {
    this.value = value;
    this.id = id;
  }

  async get() {
    return {exists: this.value !== undefined, id: this.id, data: () => this.value};
  }
}

class Db {
  constructor() {
    this.data = new Map([
      ["workspaces/workspace-1", {
        ownerUid: "user-1",
        agentRuntimeAuthorityState: "admitted",
        agentRuntimeSessionId: "main-session",
        agentRuntimeGeneration: 2,
        agentRuntimeBootInstanceId: "main-boot",
      }],
      ["workspaces/workspace-1/sessions/session-1", {
        ownerUid: "user-1", workspaceId: "workspace-1", runtimeKind: "automation", status: "running",
        agentRuntimeAuthorityState: "admitted", agentRuntimeSessionId: "session-1",
        agentRuntimeGeneration: 7, agentRuntimeBootInstanceId: "boot-1", shutdownToken: "runner-secret",
      }],
      ["automationRuns/run-1", {ownerUid: "user-1", workspaceId: "workspace-1"}],
      ["automationRuns/run-sibling", {ownerUid: "user-1", workspaceId: "workspace-2"}],
    ]);
  }

  collection(name) {
    return {doc: (id) => new Ref(this.data.get(`${name}/${id}`), id)};
  }

  sessionCollection(workspaceId) {
    return {doc: (id) => new Ref(this.data.get(`workspaces/${workspaceId}/sessions/${id}`), id)};
  }
}

function setup() {
  const db = new Db();
  const auth = createAutomationAgentAuthService({
    db,
    now: () => Date.parse("2026-09-20T12:00:00Z"),
    secret: "test-signing-secret",
    sessionCollection: (workspaceId) => db.sessionCollection(workspaceId),
  });
  const calls = [];
  const record = (entry, value) => {
    calls.push(entry);
    return value;
  };
  const service = createAutomationAgentApiService({
    authService: auth,
    cleanupService: {stopRun: async (...args) => calls.push(["stop", ...args])},
    db,
    definitionsService: {
      createAutomation: async (...args) => record(["create", ...args], {id: "automation-1"}),
      deleteAutomation: async (...args) => record(["delete", ...args], {ok: true}),
      getAutomation: async (...args) => record(["get", ...args], {id: "automation-1"}),
      getAutomationSettings: async (...args) => record(["settings", ...args], {automationMaxConcurrency: 1}),
      listAutomations: async (...args) => record(["list", ...args], []),
      updateAutomation: async (...args) => record(["update", ...args], {id: "automation-1"}),
      updateAutomationSettings: async (...args) => record(["settingsUpdate", ...args], {automationMaxConcurrency: 2}),
    },
    historyService: {
      getRun: async (...args) => record(["getRun", ...args], {runId: args[1]}),
      listEvents: async (...args) => record(["events", ...args], {events: []}),
      listRuns: async (...args) => record(["runs", ...args], {runs: []}),
    },
    runsService: {
      cancelQueuedRun: async (...args) => record(["cancel", ...args], {runId: args[1]}),
      enqueueRun: async (...args) => record(["enqueue", ...args], {runId: "run-new"}),
      restartRun: async (...args) => record(["restart", ...args], {runId: "run-new"}),
    },
    sessionCollection: (workspaceId) => db.sessionCollection(workspaceId),
  });
  return {auth, calls, db, service};
}

async function tokenFor(auth) {
  return (await auth.mintToken({
    body: {workspaceId: "workspace-1", sessionId: "session-1"},
    method: "POST",
    get: () => "runner-secret",
  })).accessToken;
}

function request(token, method, body = {}, query = {}) {
  return {body, headers: {authorization: `Bearer ${token}`}, method, query};
}

test("agent API forces workspace scope and attributes mutations to the live session", async () => {
  const {auth, calls, service} = setup();
  const token = await tokenFor(auth);
  const list = await service.handleRequest(request(token, "GET", {}, {workspaceId: "workspace-2"}), {
    resource: "runs", action: "list",
  });
  assert.deepEqual(list.body, {runs: []});
  assert.equal(calls[0][0], "runs");
  assert.equal(calls[0][1], "user-1");
  assert.equal(calls[0][2].workspaceId, "workspace-1");

  await service.handleRequest(request(token, "POST", {name: "Agent edit"}), {
    resource: "definitions", action: "list",
  });
  assert.equal(calls[1][0], "create");
  assert.deepEqual(calls[1][4], {actorType: "agent", sessionId: "session-1"});

  await assert.rejects(
      () => service.handleRequest(request(token, "GET"), {resource: "run", action: "detail", runId: "run-sibling"}),
      (error) => error.status === 404 && error.publicMessage === "automation_run_not_found",
  );
  assert.equal(calls.some(([name]) => name === "getRun"), false);
});

test("agent API revokes a still-unexpired token when the boot changes", async () => {
  const {auth, db, service} = setup();
  const token = await tokenFor(auth);
  db.data.set("workspaces/workspace-1/sessions/session-1", {
    ...db.data.get("workspaces/workspace-1/sessions/session-1"),
    agentRuntimeBootInstanceId: "boot-2",
  });
  await assert.rejects(
      () => service.handleRequest(request(token, "GET"), {resource: "definitions", action: "list"}),
      (error) => error.status === 401 && error.publicMessage === "automation_agent_unauthorized",
  );
});
