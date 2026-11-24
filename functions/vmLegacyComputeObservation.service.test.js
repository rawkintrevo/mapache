"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createVmLegacyComputeObserver} = require("./vmLegacyComputeObservation.service");

function run(request) {
  return createVmLegacyComputeObserver({auth: {getClient: async () => ({request})}, projectNumber: "123"});
}
const missing = () => { throw Object.assign(Error("private provider details"), {response: {status: 404}}); };
const known = {id: "session", serviceId: "session-legacy",
  serviceName: "projects/123/locations/us-central1/services/session-legacy",
  provisioningCloudRunOperationName: "projects/123/locations/us-central1/operations/op-123"};

test("deduplicates recorded and derived services and verifies absence and terminal operation", async () => {
  const observed = await run(({url, method}) => {
    assert.equal(method, "GET");
    if (url.endsWith("/services/session-legacy")) return missing();
    assert.equal(url, "https://run.googleapis.com/v2/projects/pi-agents-cloud/locations/us-central1/operations/op-123");
    return {data: {done: true}};
  })([known]);
  assert.equal(observed.referencedServices, 1);
  assert.equal(observed.absentServices, 1);
  assert.equal(observed.terminalOperations, 1);
  assert.equal(observed.recordedComputeClear, true);
  assert.ok(!JSON.stringify(observed).includes("session-legacy"));
});

test("present services, pending operations and unknown operation history block a clear result", async () => {
  const present = await run(() => ({data: {}}))([known]);
  assert.ok(present.blockers.includes("legacy_cloud_run_service_present"));
  assert.ok(present.blockers.includes("legacy_cloud_run_operation_pending"));
  const unavailable = await run(missing)([known]);
  assert.equal(unavailable.absentServices, 1);
  assert.equal(unavailable.recordedComputeClear, false);
  assert.deepEqual(unavailable.blockers, ["legacy_cloud_run_operation_unavailable"]);
});

test("foreign references and missing operation names fail before provider reads", async () => {
  const unexpected = () => assert.fail("unexpected request");
  const foreign = await run(unexpected)([{...known, serviceName: known.serviceName.replace("/123/", "/foreign/")}]);
  assert.ok(foreign.blockers.includes("legacy_compute_reference_invalid"));
  const unknown = await run(unexpected)([{...known, provisioningState: "running", provisioningCloudRunOperationName: null}]);
  assert.ok(unknown.blockers.includes("legacy_compute_operation_reference_missing"));
});
