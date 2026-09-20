"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createWorkspaceAuthority} = require("./workspaceAuthority");

const admin = {
  firestore: {FieldValue: {serverTimestamp: () => "SERVER_TIMESTAMP"}},
};

function createStore(workspace, sessions) {
  const workspaceRef = {id: "workspace-1"};
  const sessionsRef = {id: "sessions"};
  const sessionRefs = new Map(Object.keys(sessions).map((id) => [id, {id}]));
  let available = true;
  workspaceRef.collection = (name) => {
    assert.equal(name, "sessions");
    return sessionsRef;
  };
  sessionsRef.doc = (id) => {
    if (!sessionRefs.has(id)) sessionRefs.set(id, {id});
    return sessionRefs.get(id);
  };

  const dataFor = (ref) => {
    if (ref === workspaceRef) return {exists: true, data: () => workspace};
    const session = sessions[ref.id];
    return {exists: Boolean(session), data: () => session || {}};
  };

  return {
    setAvailable(value) {
      available = value;
    },
    db: {
      collection(name) {
        assert.equal(name, "workspaces");
        return {doc: (id) => {
          assert.equal(id, "workspace-1");
          return workspaceRef;
        }};
      },
      runTransaction: async (callback) => {
        if (!available) {
          const error = new Error("coordination store unavailable");
          error.code = "UNAVAILABLE";
          throw error;
        }
        return callback({
          get: async (ref) => dataFor(ref),
          update: (ref, updates) => Object.assign(ref === workspaceRef ? workspace : sessions[ref.id], updates),
        });
      },
    },
    workspace,
    sessions,
  };
}

function config(sessionId, generation) {
  return {
    agentRuntimeEnabled: true,
    agentRuntimeGeneration: String(generation),
    agentUiVersion: "pi-web-ui-v1",
    sessionId,
    workspaceId: "workspace-1",
    workspaceAuthorityRenewalIntervalMs: 60_000,
  };
}

function automationConfig(sessionId, generation, runId) {
  return {...config(sessionId, generation), runtimeKind: "automation", automationRunId: runId};
}

function initialStore() {
  const workspace = {
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeGeneration: 1,
    agentRuntimeOperationId: "operation-1",
    agentRuntimeSessionId: "session-a",
    agentRuntimeState: "starting",
  };
  const sessions = {
    "session-a": {
      agentUiVersion: "pi-web-ui-v1",
      agentRuntimeGeneration: 1,
      agentRuntimeOperationId: "operation-1",
      agentRuntimeState: "starting",
      status: "provisioning",
    },
  };
  return createStore(workspace, sessions);
}

test("fences duplicate boots and rejects delayed work after controlled generation handoff", async () => {
  const store = initialStore();
  const stopped = [];
  const instanceA = createWorkspaceAuthority({
    admin,
    config: config("session-a", 1),
    db: store.db,
    instanceId: "boot-a",
    onLost: () => stopped.push("a"),
  });
  const duplicate = createWorkspaceAuthority({
    admin,
    config: config("session-a", 1),
    db: store.db,
    instanceId: "boot-b",
  });

  await instanceA.acquire();
  assert.equal(instanceA.isCurrentWriter(), true);
  assert.equal(store.workspace.agentRuntimeBootInstanceId, "boot-a");
  await assert.rejects(() => duplicate.acquire(), (error) => error.code === "workspace_runtime_authority_denied");

  // This models the controlled stop/recreate transaction. It clears A's
  // authority before reserving the next generation for B.
  Object.assign(store.workspace, {
    agentRuntimeAuthorityState: "released",
    agentRuntimeBootInstanceId: null,
    agentRuntimeGeneration: 2,
    agentRuntimeOperationId: "operation-2",
    agentRuntimeSessionId: "session-b",
    agentRuntimeState: "starting",
  });
  store.sessions["session-a"].status = "stopped";
  store.sessions["session-a"].agentRuntimeState = "stopped";
  store.sessions["session-a"].agentRuntimeAuthorityState = "released";
  store.sessions["session-a"].agentRuntimeBootInstanceId = null;
  store.sessions["session-b"] = {
    agentUiVersion: "pi-web-ui-v1",
    agentRuntimeGeneration: 2,
    agentRuntimeOperationId: "operation-2",
    agentRuntimeState: "starting",
    status: "provisioning",
  };
  const instanceB = createWorkspaceAuthority({
    admin,
    config: config("session-b", 2),
    db: store.db,
    instanceId: "boot-b",
  });
  await instanceB.acquire();
  assert.equal(store.workspace.agentRuntimeBootInstanceId, "boot-b");
  await assert.rejects(() => instanceA.assertCurrentWriter(), (error) => error.code === "workspace_runtime_generation_mismatch");
  assert.equal(instanceA.isCurrentWriter(), false);
  assert.deepEqual(stopped, ["a"]);
  await instanceB.release("test");
});

test("coordination loss fails closed and invokes child termination", async () => {
  const store = initialStore();
  let childTerminated = false;
  const authority = createWorkspaceAuthority({
    admin,
    config: config("session-a", 1),
    db: store.db,
    instanceId: "boot-a",
    onLost: async () => {
      childTerminated = true;
    },
  });
  await authority.acquire();
  store.setAvailable(false);
  await assert.rejects(() => authority.renew(), (error) => error.code === "workspace_runtime_coordination_unavailable");
  assert.equal(authority.isCurrentWriter(), false);
  assert.equal(childTerminated, true);
  await assert.rejects(() => authority.assertCurrentWriter(), (error) => error.code === "workspace_writer_authority_lost");
});

test("keeps the admitted writer usable for the bounded final save during stopping", async () => {
  const store = initialStore();
  store.workspace.agentRuntimeState = "stopping";
  store.sessions["session-a"].status = "stopping";
  const authority = createWorkspaceAuthority({
    admin,
    config: config("session-a", 1),
    db: store.db,
    instanceId: "boot-a",
  });

  await authority.acquire();
  await authority.assertCurrentWriter();
  assert.equal(authority.isCurrentWriter(), true);
});

test("automation authority is session-scoped and rejects a duplicate boot without touching workspace authority", async () => {
  const store = createStore({agentUiVersion: "pi-web-ui-v1"}, {
    "auto-run-1": {
      agentUiVersion: "pi-web-ui-v1",
      runtimeKind: "automation",
      automationRunId: "run-1",
      agentRuntimeSessionId: "auto-run-1",
      agentRuntimeGeneration: 1,
      agentRuntimeState: "starting",
      status: "provisioning",
    },
  });
  const first = createWorkspaceAuthority({
    admin,
    config: automationConfig("auto-run-1", 1, "run-1"),
    db: store.db,
    instanceId: "boot-a",
  });
  const duplicate = createWorkspaceAuthority({
    admin,
    config: automationConfig("auto-run-1", 1, "run-1"),
    db: store.db,
    instanceId: "boot-b",
  });

  await first.acquire();
  assert.equal(store.workspace.agentRuntimeBootInstanceId, undefined);
  assert.equal(store.sessions["auto-run-1"].agentRuntimeBootInstanceId, "boot-a");
  await assert.rejects(() => duplicate.acquire(), (error) => error.code === "workspace_runtime_authority_denied");
  await first.assertCurrentWriter();
  await first.release("test");
  assert.equal(store.workspace.agentRuntimeBootInstanceId, undefined);
  assert.equal(store.sessions["auto-run-1"].agentRuntimeBootInstanceId, null);
});
