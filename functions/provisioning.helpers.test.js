"use strict";

const assert = require("node:assert/strict");
const {
  cloudRunServiceId,
  initialProvisioningMetadata,
  isRetryableProvisioningError,
  isValidCloudRunServiceId,
  normalizeProvisioningOperationId,
  provisioningSessionId,
  resolveCloudRunServiceId,
} = require("./provisioning.helpers");

const generatedId = normalizeProvisioningOperationId();
assert.match(generatedId, /^[0-9a-f-]{36}$/);
assert.strictEqual(normalizeProvisioningOperationId(" operation-1 "), "operation-1");
assert.throws(() => normalizeProvisioningOperationId("bad id"), /invalid_provisioning_operation_id|safe characters/);
assert.strictEqual(provisioningSessionId("operation-1"), provisioningSessionId("operation-1"));
assert.notStrictEqual(provisioningSessionId("operation-1"), provisioningSessionId("operation-2"));
assert.strictEqual(cloudRunServiceId("operation-1"), cloudRunServiceId("operation-1"));
assert.notStrictEqual(cloudRunServiceId("operation-1"), cloudRunServiceId("operation-2"));
assert.strictEqual(isValidCloudRunServiceId(cloudRunServiceId("operation-1")), true);
assert.ok(cloudRunServiceId("operation-1").length < 50);
assert.strictEqual(resolveCloudRunServiceId("operation-1", "session-existing"), "session-existing");
assert.strictEqual(resolveCloudRunServiceId("operation-1", "session-operation-000000000000000000000000000000000000000000"), cloudRunServiceId("operation-1"));
assert.deepStrictEqual(initialProvisioningMetadata("operation-1"), {
  provisioningOperationId: "operation-1",
  provisioningAttempt: 0,
  provisioningState: "pending",
  provisioningCloudRunOperationName: null,
  provisioningAttemptStartedAt: null,
  provisioningAttemptCompletedAt: null,
  provisioningRetryable: false,
  provisioningLastError: null,
});
assert.strictEqual(isRetryableProvisioningError({code: "cloud_run_operation_timeout"}), true);
assert.strictEqual(isRetryableProvisioningError({status: 503}), true);
assert.strictEqual(isRetryableProvisioningError({status: 400}), false);
assert.strictEqual(isRetryableProvisioningError(new Error("permission denied")), false);

console.log("provisioning helper tests passed");
