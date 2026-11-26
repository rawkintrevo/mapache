"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {resolveRuntimeGatewayBaseUrl} = require("./runtimeGateway.helpers");

test("selects the public gateway from the configured host list", () => {
  assert.equal(resolveRuntimeGatewayBaseUrl({
    VM_WORKSPACE_GATEWAY_HOSTS: "backup-recovery---gateway.example,gateway.example",
  }), "https://gateway.example");
});

test("prefers an explicit runtime gateway and preserves its scheme", () => {
  assert.equal(resolveRuntimeGatewayBaseUrl({
    VM_REMOTE_VM_GATEWAY_BASE_URL: "https://remote.example",
    VM_RUNTIME_GATEWAY_BASE_URL: "runtime.example",
    VM_WORKSPACE_GATEWAY_HOSTS: "gateway.example",
  }), "https://remote.example");
  assert.equal(resolveRuntimeGatewayBaseUrl({VM_RUNTIME_GATEWAY_BASE_URL: "http://runtime.example"}), "http://runtime.example");
});

test("returns no gateway when only recovery hosts are configured", () => {
  assert.equal(resolveRuntimeGatewayBaseUrl({VM_WORKSPACE_GATEWAY_HOSTS: "backup-recovery---gateway.example"}), "");
});
