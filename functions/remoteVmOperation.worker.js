"use strict";

function createRemoteVmOperationWorker(service) {
  return async (event) => {
    const after = event.data?.after;
    if (!after?.exists || after.data()?.state !== "queued") return null;
    // Retry the original queue event with platform backoff. Failure writes must
    // not create a fresh event loop, including permanent application errors.
    const result = await service.reconcileOperation(event.params.operationId, {retryFailed: false});
    if (["running", "queued", "unreachable"].includes(result?.state)) {
      throw new Error("remote_vm_operation_pending");
    }
    return result;
  };
}

module.exports = {createRemoteVmOperationWorker};
