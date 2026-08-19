"use strict";

const assert = require("node:assert/strict");
const {
  createProvisioningWorker,
  isQueuedProvisioningSession,
} = require("./provisioning.worker");

assert.strictEqual(isQueuedProvisioningSession({status: "provisioning", provisioningState: "queued"}), true);
assert.strictEqual(isQueuedProvisioningSession({status: "provisioning", provisioningState: "running"}), false);
assert.strictEqual(isQueuedProvisioningSession({status: "running", provisioningState: "queued"}), false);

(async () => {
  const session = {
    ownerUid: "uid-1",
    workspaceId: "workspace-1",
    status: "provisioning",
    provisioningOperationId: "operation-1",
    provisioningState: "queued",
  };
  const updates = [];
  const workspace = {id: "workspace-1", ownerUid: "uid-1"};
  const sessionRef = {
    update: async (update) => updates.push(update),
  };
  const calls = [];
  const worker = createProvisioningWorker({
    requireWorkspace: async (uid, workspaceId) => {
      calls.push({uid, workspaceId});
      return workspace;
    },
    provisionSessionService: async (receivedWorkspace, receivedRef, receivedSession) => {
      calls.push({receivedWorkspace, receivedRef, receivedSession});
    },
  }).provisionQueuedSession;

  const result = await worker({
    params: {workspaceId: "workspace-1", sessionId: "session-1"},
    data: {
      after: {
        id: "session-1",
        ref: sessionRef,
        exists: true,
        data: () => session,
      },
    },
  });
  assert.deepStrictEqual(result, {provisioned: true, sessionId: "session-1"});
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0], {uid: "uid-1", workspaceId: "workspace-1"});
  assert.strictEqual(calls[1].receivedWorkspace, workspace);
  assert.strictEqual(calls[1].receivedRef, sessionRef);
  assert.strictEqual(calls[1].receivedSession.id, "session-1");

  const ignored = await worker({
    params: {workspaceId: "workspace-1", sessionId: "session-2"},
    data: {
      after: {
        id: "session-2",
        ref: sessionRef,
        exists: true,
        data: () => ({...session, provisioningState: "running"}),
      },
    },
  });
  assert.deepStrictEqual(ignored, {skipped: "not_queued"});
  assert.strictEqual(calls.length, 2);

  const failureUpdates = [];
  const failureRef = {update: async (update) => failureUpdates.push(update)};
  const failureWorker = createProvisioningWorker({
    requireWorkspace: async () => {
      throw new Error("workspace lookup failed");
    },
    provisionSessionService: async () => {},
  }).provisionQueuedSession;
  const failed = await failureWorker({
    params: {workspaceId: "workspace-1", sessionId: "session-1"},
    data: {
      after: {
        id: "session-1",
        ref: failureRef,
        exists: true,
        data: () => session,
      },
    },
  });
  assert.deepStrictEqual(failed, {provisioned: false, sessionId: "session-1"});
  assert.strictEqual(failureUpdates.length, 1);
  assert.strictEqual(failureUpdates[0].status, "provision_failed");
  assert.strictEqual(failureUpdates[0].provisioningState, "failed");
  assert.strictEqual(failureUpdates[0].provisioningRetryable, false);
  assert.strictEqual(failureUpdates[0].lastError, "workspace lookup failed");

  console.log("provisioning worker tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
