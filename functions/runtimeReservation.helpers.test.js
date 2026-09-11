"use strict";

const assert = require("node:assert/strict");
const {
  isActiveMarkedRuntimeSession,
  isMarkedRuntimeWorkspace,
  nextRuntimeGeneration,
  resolveRuntimeReservation,
  runtimeSessionStateUpdate,
  runtimeStateUpdate,
} = require("./runtimeReservation.helpers");
const {AGENT_UI_VERSION} = require("./agentRuntime.helpers");

const workspace = {agentUiVersion: AGENT_UI_VERSION, agentRuntimeGeneration: 4};
const session = {
  id: "session-a",
  agentUiVersion: AGENT_UI_VERSION,
  agentRuntimeGeneration: 4,
  capabilities: {chrome: true},
  status: "running",
};

assert.strictEqual(isMarkedRuntimeWorkspace(workspace), true);
assert.strictEqual(isActiveMarkedRuntimeSession(session), true);
assert.strictEqual(isActiveMarkedRuntimeSession({...session, status: "stopping"}), true);
assert.strictEqual(isActiveMarkedRuntimeSession({...session, status: "provision_failed"}), false);
assert.strictEqual(nextRuntimeGeneration(workspace, [session, {agentRuntimeGeneration: 9}]), 10);

const reservation = resolveRuntimeReservation(
    {agentUiVersion: AGENT_UI_VERSION},
    [],
    {...session, agentRuntimeGeneration: 0},
    session.id,
    "operation-a",
    {enabled: true, now: "SERVER_TIMESTAMP"},
);
assert.deepStrictEqual(reservation.sessionUpdates, {
  agentRuntimeOperationId: "operation-a",
  agentRuntimeGeneration: 1,
  agentRuntimeState: "starting",
});
assert.deepStrictEqual(reservation.workspaceUpdates, {
  agentRuntimeSessionId: "session-a",
  agentRuntimeOperationId: "operation-a",
  agentRuntimeGeneration: 1,
  agentRuntimeState: "starting",
  agentRuntimeUpdatedAt: "SERVER_TIMESTAMP",
});

const conflicting = resolveRuntimeReservation(
    {...workspace, agentRuntimeSessionId: "session-a", agentRuntimeState: "running"},
    [session],
    {...session, id: "session-b"},
    "session-b",
    "operation-b",
    {enabled: true},
);
assert.strictEqual(conflicting.conflict, "session-a");
assert.deepStrictEqual(runtimeStateUpdate(
    {...workspace, agentRuntimeSessionId: session.id},
    session,
    "running",
    "SERVER_TIMESTAMP",
), {
  agentRuntimeSessionId: session.id,
  agentRuntimeState: "running",
  agentRuntimeUpdatedAt: "SERVER_TIMESTAMP",
});
assert.deepStrictEqual(runtimeStateUpdate(
    {...workspace, agentRuntimeSessionId: session.id},
    session,
    "failed",
    "SERVER_TIMESTAMP",
    {release: true},
), {
  agentRuntimeSessionId: null,
  agentRuntimeState: "failed",
  agentRuntimeUpdatedAt: "SERVER_TIMESTAMP",
});
assert.deepStrictEqual(runtimeSessionStateUpdate(session, "running"), {agentRuntimeState: "running"});
assert.deepStrictEqual(runtimeSessionStateUpdate({}, "running"), {});

console.log("runtime reservation helper tests passed");
