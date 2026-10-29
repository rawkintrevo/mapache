"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createActivityService} = require("./activity");

function createHarness(session) {
  const updates = [];
  const ref = {
    update: async (update) => updates.push(update),
  };
  const db = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ref,
        }),
      }),
    }),
    runTransaction: async (callback) => callback({
      get: async () => ({exists: true, data: () => session}),
      update: (target, update) => {
        assert.equal(target, ref);
        updates.push(update);
        Object.assign(session, update);
      },
    }),
  };
  const admin = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => "server-timestamp",
      },
    },
  };
  const activity = createActivityService({
    admin,
    db,
    config: {workspaceId: "workspace-a", sessionId: "session-a"},
  });
  return {activity, session, updates};
}

function createOwnedHarness({workspace, session, identity, automationRunId, runtimeKind = "main", logger = {warn: () => {}}}) {
  const updates = [];
  const workspaceRef = {kind: "workspace"};
  const sessionRef = {kind: "session"};
  workspaceRef.collection = () => ({doc: () => sessionRef});
  const db = {
    collection: () => ({doc: () => workspaceRef}),
    runTransaction: async (callback) => callback({
      get: async (ref) => ref === workspaceRef ?
        {exists: true, data: () => workspace} :
        {exists: true, data: () => session},
      update: (target, update) => {
        assert.equal(target, sessionRef);
        updates.push(update);
        Object.assign(session, update);
      },
    }),
  };
  const admin = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => "server-timestamp",
      },
    },
  };
  const activity = createActivityService({
    admin,
    db,
    config: {
      agentRuntimeGeneration: 1,
      automationRunId,
      runtimeKind,
      sessionId: "session-a",
      workspaceId: "workspace-a",
    },
    getRuntimeIdentity: () => identity,
    logger,
  });
  return {activity, session, updates};
}

test("runtime startup failure marks a running session update_failed", async () => {
  const harness = createHarness({status: "running", lastError: "github_clone_auth_failed"});

  await harness.activity.markRuntimeStartupFailure(new Error("runner could not restore workspace"));

  assert.equal(harness.updates.length, 1);
  assert.deepEqual(harness.updates[0], {
    activeSocketCount: 0,
    lastError: "github_clone_auth_failed",
    runtimeFailedAt: "server-timestamp",
    runtimeLastError: "runner could not restore workspace",
    runtimeState: "failed",
    updatedAt: "server-timestamp",
    status: "update_failed",
  });
});

test("runtime startup failure leaves provisioning status for Functions to resolve", async () => {
  const harness = createHarness({status: "provisioning"});

  await harness.activity.markRuntimeStartupFailure(new Error("initial clone failed"));

  assert.equal(harness.updates.length, 1);
  assert.equal(harness.updates[0].status, undefined);
  assert.equal(harness.updates[0].lastError, "initial clone failed");
  assert.equal(harness.updates[0].runtimeState, "failed");
});

test("duplicate boot cannot publish startup failure over the admitted owner", async () => {
  const warnings = [];
  const harness = createOwnedHarness({
    workspace: {
      agentRuntimeAuthorityState: "admitted",
      agentRuntimeBootInstanceId: "boot-a",
      agentRuntimeGeneration: 1,
      agentRuntimeSessionId: "session-a",
    },
    session: {
      agentRuntimeAuthorityState: "admitted",
      agentRuntimeBootInstanceId: "boot-a",
      agentRuntimeGeneration: 1,
      status: "running",
    },
    identity: {admitted: false, bootInstanceId: "boot-b", enabled: true, generation: 1},
    logger: {warn: (_message, details) => warnings.push(details)},
  });

  await harness.activity.markRuntimeStartupFailure(new Error("workspace_runtime_authority_denied"), {
    allowUnadmitted: true,
  });

  assert.deepEqual(harness.updates, []);
  assert.equal(harness.session.status, "running");
  assert.deepEqual(warnings, [{
    bootInstanceId: "boot-b",
    generation: 1,
    reason: "boot_ownership_mismatch",
    sessionId: "session-a",
    workspaceId: "workspace-a",
  }]);
});

test("pre-admission startup failure remains visible when no boot owns the reservation", async () => {
  const harness = createOwnedHarness({
    workspace: {
      agentRuntimeAuthorityState: "released",
      agentRuntimeGeneration: 1,
      agentRuntimeSessionId: "session-a",
    },
    session: {
      agentRuntimeGeneration: 1,
      status: "provisioning",
    },
    identity: {admitted: false, bootInstanceId: "boot-a", enabled: true, generation: 1},
  });

  await harness.activity.markRuntimeStartupFailure(new Error("initial clone failed"), {
    allowUnadmitted: true,
  });

  assert.equal(harness.updates[0].runtimeLastError, "initial clone failed");
  assert.equal(harness.updates[0].runtimeState, "failed");
  assert.equal(harness.updates[0].status, undefined);
});

test("current owner can publish a post-admission startup failure", async () => {
  const harness = createOwnedHarness({
    workspace: {
      agentRuntimeAuthorityState: "admitted",
      agentRuntimeBootInstanceId: "boot-a",
      agentRuntimeGeneration: 1,
      agentRuntimeSessionId: "session-a",
    },
    session: {
      agentRuntimeAuthorityState: "admitted",
      agentRuntimeBootInstanceId: "boot-a",
      agentRuntimeGeneration: 1,
      status: "running",
    },
    identity: {admitted: true, bootInstanceId: "boot-a", enabled: true, generation: 1},
  });

  await harness.activity.markRuntimeStartupFailure(new Error("pi_web_ui_health_timeout"));

  assert.equal(harness.updates[0].status, "update_failed");
  assert.equal(harness.updates[0].runtimeLastError, "pi_web_ui_health_timeout");
});

test("stale generation cannot publish a startup failure onto a newer reservation", async () => {
  const warnings = [];
  const harness = createOwnedHarness({
    workspace: {
      agentRuntimeAuthorityState: "released",
      agentRuntimeGeneration: 2,
      agentRuntimeSessionId: "session-a",
    },
    session: {
      agentRuntimeGeneration: 2,
      status: "provisioning",
    },
    identity: {admitted: false, bootInstanceId: "boot-old", enabled: true, generation: 1},
    logger: {warn: (_message, details) => warnings.push(details)},
  });

  await harness.activity.markRuntimeStartupFailure(new Error("old generation failed"), {
    allowUnadmitted: true,
  });

  assert.deepEqual(harness.updates, []);
  assert.equal(warnings[0].reason, "generation_mismatch");
});

test("automation duplicate boot cannot publish against its run session", async () => {
  const harness = createOwnedHarness({
    runtimeKind: "automation",
    automationRunId: "run-a",
    workspace: {},
    session: {
      agentRuntimeAuthorityState: "admitted",
      agentRuntimeBootInstanceId: "boot-a",
      agentRuntimeGeneration: 1,
      agentRuntimeSessionId: "session-a",
      automationRunId: "run-a",
      runtimeKind: "automation",
      status: "running",
    },
    identity: {admitted: false, bootInstanceId: "boot-b", enabled: true, generation: 1},
  });

  await harness.activity.markRuntimeStartupFailure(new Error("workspace_runtime_authority_denied"), {
    allowUnadmitted: true,
  });

  assert.deepEqual(harness.updates, []);
  assert.equal(harness.session.status, "running");
});
