"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {vmMachineTypeForResources} = require("./vmMachineResources.helpers");

test("maps the shared resource catalog to validated E2 custom shapes", () => {
  assert.equal(vmMachineTypeForResources({cpu: "1", memory: "2Gi"}), "e2-custom-medium-2048");
  assert.equal(vmMachineTypeForResources({cpu: "2", memory: "4Gi"}), "e2-custom-2-4096");
  assert.equal(vmMachineTypeForResources({cpu: "6", memory: "24Gi"}), "e2-custom-6-24576");
  assert.equal(vmMachineTypeForResources(null), null);
});

test("rejects resource shapes that cannot be represented by the E2 contract", () => {
  assert.throws(() => vmMachineTypeForResources({cpu: "3", memory: "4Gi"}), /invalid_session_resources/);
  assert.throws(() => vmMachineTypeForResources({cpu: "4", memory: "1Gi"}), /invalid_session_resources/);
});
