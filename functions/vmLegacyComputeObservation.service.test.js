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

test("regional discovery follows pages and detects a detached registry service and a Storage alias", async () => {
  const identity = {workspaceId: "target-ws", ownerUid: "target-owner", workspace: {bucket: "bucket", storagePrefix: "owned-tree"}};
  const service = (name, env) => ({
    name: `projects/123/locations/us-central1/services/${name}`,
    template: {containers: [{env: Object.entries(env).map(([name, value]) => ({name, value}))}]},
  });
  const result = await run(({url, params}) => {
    assert.ok(url.endsWith("/locations/us-central1/services"));
    if (!params.pageToken) return {data: {nextPageToken: "next", services: [
      service("session-orphan", {WORKSPACE_ID: "target-ws", OWNER_UID: "target-owner", PRIVATE: "secret"}),
    ]}};
    return {data: {services: [
      service("session-alias", {WORKSPACE_ID: "other-ws", STORAGE_BUCKET: "bucket", STORAGE_PREFIX: "owned-tree"}),
      service("session-unknown", {}),
      service("session-other", {WORKSPACE_ID: "different"}),
    ]}};
  })([], identity);
  assert.equal(result.discovery.inspectedServices, 4);
  assert.equal(result.discovery.unrecordedMatches, 2);
  assert.equal(result.discovery.scannedRegionsClear, false);
  assert.deepEqual(result.blockers, ["legacy_cloud_run_runner_identity_unresolved", "legacy_cloud_run_storage_alias_present",
    "legacy_cloud_run_unrecorded_service_present"]);
  assert.ok(!/session-orphan|secret/.test(JSON.stringify(result)));
});

test("repeated provider page token leaves regional discovery incomplete", async () => {
  const result = await run(() => ({data: {nextPageToken: "same"}}))([], {
    workspaceId: "target-ws", ownerUid: "target-owner", workspace: {},
  });
  assert.equal(result.discovery.scannedRegionsClear, false);
  assert.ok(result.blockers.includes("legacy_cloud_run_discovery_incomplete"));
});
