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
