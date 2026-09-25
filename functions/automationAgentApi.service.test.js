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

function setup(runtimeKind = "automation") {
  const db = new Db();
  if (runtimeKind === "main" || runtimeKind === "legacy-main") {
    const session = db.data.get("workspaces/workspace-1/sessions/session-1");
    session.runnerSessionId = "session-1";
    delete session.agentRuntimeSessionId;
    if (runtimeKind === "legacy-main") delete session.runtimeKind;
    else session.runtimeKind = "main";
    Object.assign(db.data.get("workspaces/workspace-1"), {
      agentRuntimeAuthorityState: "admitted", agentRuntimeSessionId: "session-1",
      agentRuntimeGeneration: 7, agentRuntimeBootInstanceId: "boot-1",
    });
  }
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
    previewAutomationSchedule: (body) => ({
      occurrences: [{local: "2026-09-21T09:00", utc: "2026-09-21T14:00:00.000Z", timezone: body.timezone}],
    }),
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

for (const runtimeKind of ["main", "legacy-main", "automation"]) {
  test(`${runtimeKind} agent API forces workspace scope and attributes mutations to the live session`, async () => {
    const {auth, calls, service} = setup(runtimeKind);
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

  test(`${runtimeKind} agent API revokes a still-unexpired token when the boot changes`, async () => {
    const {auth, db, service} = setup(runtimeKind);
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

  test(`${runtimeKind} agent API previews schedules without accepting a workspace parameter`, async () => {
    const {auth, service} = setup(runtimeKind);
    const token = await tokenFor(auth);
    const result = await service.handleRequest(request(token, "POST", {
      cron: "0 9 * * *", timezone: "America/Chicago", workspaceId: "workspace-2",
    }), {resource: "schedule", action: "preview"});
    assert.deepEqual(result.body.occurrences[0].timezone, "America/Chicago");
  });

}

for (const [target, patch] of [
  ["workspace", {agentRuntimeSessionId: "replacement"}],
  ["workspace", {agentRuntimeGeneration: 8}],
  ["workspace", {agentRuntimeBootInstanceId: "new-boot"}],
  ["workspace", {agentRuntimeAuthorityState: "released"}],
  ["session", {runnerSessionId: "replacement"}],
  ["session", {status: "stopped"}],
  ["session", {agentRuntimeAuthorityState: "released"}],
]) {
  test(`main tokens revoked and mint refused after ${target} changes ${JSON.stringify(patch)}`, async () => {
    const {auth, db, service} = setup("main");
    const token = await tokenFor(auth);
    const key = target === "workspace" ? "workspaces/workspace-1" : "workspaces/workspace-1/sessions/session-1";
    Object.assign(db.data.get(key), patch);
    await assert.rejects(() => tokenFor(auth), (error) => error.status === 401);
    await assert.rejects(() => service.handleRequest(request(token, "GET"), {
      resource: "definitions", action: "list",
    }), (error) => error.status === 401);
  });
}
