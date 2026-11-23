"use strict";

const COMPUTE_PERMISSIONS = [
  "compute.instances.create", "compute.instances.delete", "compute.instances.get",
  "compute.disks.create", "compute.disks.get", "compute.disks.use",
  "compute.subnetworks.use", "compute.zoneOperations.get",
];

// Read-only rollout diagnostics. Never enable admission or mutate a workspace.
function createVmRuntimePreflight({auth, projectId = "pi-agents-cloud", env = process.env}) {
  return async function preflight() {
    const client = await auth.getClient();
    const response = await client.request({
      url: `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`,
      method: "POST",
      data: {permissions: COMPUTE_PERMISSIONS},
    });
    const granted = new Set(response.data.permissions || []);
    const missingPermissions = COMPUTE_PERMISSIONS.filter((permission) => !granted.has(permission));
    const gatewayConfigured = /^https:\/\//.test(env.VM_RUNTIME_GATEWAY_BASE_URL || "");
    return {
      projectId,
      admissionEnabled: env.VM_WORKSPACE_RUNTIME_ENABLED === "true",
      gatewayConfigured,
      missingPermissions,
      // Configuration is not proof of live routing, persistence, or recovery.
      liveValidationRequired: true,
      blockers: [
        ...(missingPermissions.length ? ["compute_permissions_missing"] : []),
        ...(!gatewayConfigured ? ["vm_gateway_not_configured"] : []),
        "live_vm_release_gates_unverified",
      ],
    };
  };
}

module.exports = {COMPUTE_PERMISSIONS, createVmRuntimePreflight};
