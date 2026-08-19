"use strict";

const crypto = require("crypto");

const PROVISIONING_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function normalizeProvisioningOperationId(value) {
  const operationId = String(value || "").trim();
  if (!operationId) return crypto.randomUUID();
  if (!PROVISIONING_OPERATION_ID_PATTERN.test(operationId)) {
    const error = new Error("Provisioning operation ID must be 1-128 safe characters.");
    error.code = "invalid_provisioning_operation_id";
    throw error;
  }
  return operationId;
}

function provisioningSessionId(operationId) {
  return `operation-${crypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`;
}

function initialProvisioningMetadata(operationId) {
  return {
    provisioningOperationId: operationId,
    provisioningAttempt: 0,
    provisioningState: "pending",
    provisioningCloudRunOperationName: null,
    provisioningAttemptStartedAt: null,
    provisioningAttemptCompletedAt: null,
    provisioningRetryable: false,
    provisioningLastError: null,
  };
}

function isRetryableProvisioningError(error) {
  if (!error) return false;
  if (error.code === "cloud_run_operation_timeout") return true;

  const status = Number(error.statusCode || error.status || error.code);
  if ([408, 425, 429].includes(status) || status >= 500) return true;

  const message = [
    error.message,
    error.response && error.response.data,
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return /deadline|timed? ?out|unavailable|temporar|connection reset|network|resource exhausted/.test(message);
}

module.exports = {
  initialProvisioningMetadata,
  isRetryableProvisioningError,
  normalizeProvisioningOperationId,
  provisioningSessionId,
};
