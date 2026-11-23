"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {COMPUTE_PERMISSIONS, createVmRuntimePreflight} = require("./vmRuntimePreflight.service");

test("preflight reports missing runtime prerequisites without claiming rollout readiness", async () => {
  const calls = [];
  const preflight = createVmRuntimePreflight({
    env: {},
    auth: {getClient: async () => ({request: async (request) => {
      calls.push(request);
      return {data: {permissions: ["compute.instances.get"]}};
    }})},
  });
  const result = await preflight();
  assert.equal(result.admissionEnabled, false);
  assert.equal(result.gatewayConfigured, false);
  assert.equal(result.missingPermissions.length, COMPUTE_PERMISSIONS.length - 1);
  assert.deepEqual(result.blockers, ["compute_permissions_missing", "vm_gateway_not_configured", "live_vm_release_gates_unverified"]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /pi-agents-cloud:testIamPermissions$/);
});

test("configured permissions and gateway do not substitute for live release evidence", async () => {
  const result = await createVmRuntimePreflight({
    env: {VM_RUNTIME_GATEWAY_BASE_URL: "https://gateway.example", VM_WORKSPACE_RUNTIME_ENABLED: "true"},
    auth: {getClient: async () => ({request: async () => ({data: {permissions: COMPUTE_PERMISSIONS}})})},
  })();
  assert.deepEqual(result.missingPermissions, []);
  assert.deepEqual(result.blockers, ["live_vm_release_gates_unverified"]);
});
