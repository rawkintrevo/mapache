"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRemoteVmOperationWorker} = require("./remoteVmOperation.worker");
const event = (state) => ({params: {operationId: "op-1"}, data: {after: {exists: true, data: () => ({state})}}});

test("failure writes do not recursively trigger operations", async () => {
  const worker = createRemoteVmOperationWorker({reconcileOperation: () => assert.fail("unexpected reconciliation")});
  for (const state of ["unreachable", "error", "running", "completed", "cancelled"]) {
    assert.equal(await worker(event(state)), null);
  }
});

test("queue event retries pending work with platform backoff", async () => {
  for (const state of ["running", "queued", "unreachable", "completed", "error", "cancelled"]) {
    const worker = createRemoteVmOperationWorker({reconcileOperation: async (id, options) => {
      assert.equal(id, "op-1");
      assert.deepEqual(options, {retryFailed: false});
      return {state};
    }});
    if (["running", "queued", "unreachable"].includes(state)) {
      await assert.rejects(worker(event("queued")), /remote_vm_operation_pending/);
    } else {
      assert.deepEqual(await worker(event("queued")), {state});
    }
  }
});
