"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {deliverRunSinks} = require("./automationCleanup.service");
const {resolveWorkspaceRunContext} = require("./workspaceRunContract.helpers");

test("provisioning resolves pinned context and exposes unavailable categories", () => {
  const refs = resolveWorkspaceRunContext({contextSnapshotRefs: [
    {kind: "workspace_files", version: "g7", source: "snapshot", state: "available"},
    {kind: "agent_settings", version: "none", source: "settings", state: "unavailable", reason: "no_persisted_descriptor"},
    {kind: "connections", version: "none", source: "workspace_brokers", state: "unavailable", reason: "not_configured"},
  ]}, {agentRuntimeWorkspaceFiles: {manifest: {generation: "g7"}}});
  assert.equal(refs[0].resolved, true);
  assert.equal(refs[1].resolved, false);
  assert.equal(refs[2].resolved, false);
});

test("cleanup calls the durable sink delivery boundary without rerunning execution", async () => {
  const data = {status: "succeeded", workspaceRunRequest: {sinks: [{kind: "ticket_result", reference: "ticket-1"}]}, sinkDelivery: {
    "ticket_result:ticket-1": {state: "pending", attempts: 0, lastError: null},
  }};
  const ref = {async get() { return {exists: true, data: () => data}; }, async update(value) { Object.assign(data, value); }};
  await deliverRunSinks(ref, "run-1", {admin: {firestore: {FieldValue: {serverTimestamp: () => "now"}}}});
  assert.equal(data.status, "succeeded");
  assert.equal(data.sinkDelivery["ticket_result:ticket-1"].state, "delivered");
  assert.equal(data.sinkDelivery["ticket_result:ticket-1"].attempts, 1);
});
