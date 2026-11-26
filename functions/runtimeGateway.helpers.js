"use strict";

function resolveRuntimeGatewayBaseUrl(env = process.env) {
  const configured = env.VM_REMOTE_VM_GATEWAY_BASE_URL || env.VM_RUNTIME_GATEWAY_BASE_URL ||
    String(env.VM_WORKSPACE_GATEWAY_HOSTS || "").split(",")
        .map((value) => value.trim())
        .find((value) => value && !value.startsWith("backup-recovery---"));
  if (!configured) return "";
  return String(configured).startsWith("http") ? String(configured) : `https://${configured}`;
}

module.exports = {resolveRuntimeGatewayBaseUrl};
