"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {fromAutomationRun, normalizeWorkspaceRunRequest} = require("./workspaceRunContract.helpers");

const context = {kind: "workspace_files", version: "generation-7", source: "gcs", freshness: "2026-09-28T10:00:00Z", state: "available"};

test("normalizes a trigger-neutral request with pinned context and sinks", () => {
  const input = {
    targetWorkspaceId: "workspace-1", actor: {type: "workspace_owner", id: "user-1"}, source: {type: "ticket", id: "ticket-1"},
    triggerKind: "http_ticket", triggerReference: "ticket-1", instructions: "Summarize the request",
    input: {request: "Recent onboarding complaints"}, contextSnapshotRefs: [context],
    model: {providerId: "provider-1", modelId: "model-1"}, resources: {cpu: "2", memory: "4Gi"},
    sinks: [{kind: "ticket_result", reference: "ticket-1"}], provenance: {source: "ticket", reference: "ticket-1"},
  };
  assert.deepEqual(normalizeWorkspaceRunRequest(input), input);
});

test("legacy automation fields map to the shared request contract", () => {
  const request = fromAutomationRun({workspaceId: "workspace-1", ownerUid: "user-1", trigger: "cron",
    occurrence: {local: "2026-09-28T10:00", timezone: "UTC"}, snapshot: {prompt: "Run the report", modelSelection: null, resources: null}});
  assert.equal(request.targetWorkspaceId, "workspace-1");
  assert.equal(request.triggerKind, "cron");
  assert.equal(request.triggerReference, "2026-09-28T10:00");
  assert.deepEqual(request.sinks, [{kind: "workspace_output", reference: "workspace-1"}]);
});

test("public request values cannot contain credential material", () => {
  assert.throws(() => normalizeWorkspaceRunRequest({targetWorkspaceId: "workspace-1",
    actor: {type: "workspace_owner", id: "user-1"}, triggerKind: "manual", instructions: "Do work",
    input: {accessToken: "must-not-persist"}}), /workspace_run_secret_in_public_request/);
});
