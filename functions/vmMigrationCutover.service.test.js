"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {cutoverReview, HEALTH_PATH, validateDestinationRuntimeEvidence} = require("./vmMigrationCutover.service");

const record = {
  workspaceId: "workspace-1", ownerUid: "owner-1", operationId: "migration-1", phase: "disk-import-verified",
  sourceGeneration: 7, diskImport: {receiptSha256: "a".repeat(64)}, validation: {cleanedAtMs: 42},
  importDestination: {operationId: "destination-1", generation: 2, diskId: "123", diskName: "mapache-ws-disk"},
};

function evidence(overrides = {}) {
  return {
    schemaVersion: 1, workspaceId: record.workspaceId, ownerUid: record.ownerUid,
    migrationOperationId: record.operationId, destinationOperationId: record.importDestination.operationId,
    sourceGeneration: record.sourceGeneration, destinationGeneration: record.importDestination.generation,
    diskId: record.importDestination.diskId, diskName: record.importDestination.diskName,
    diskReceiptSha256: record.diskImport.receiptSha256, sessionId: "vm-session-1",
    runtime: {state: "active", generation: record.importDestination.generation,
      runnerImage: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:" + "b".repeat(64),
      gatewayHost: "gateway.example.com", health: {path: HEALTH_PATH, status: 200, agentReady: true},
      disk: {diskId: record.importDestination.diskId, diskName: record.importDestination.diskName,
        attached: true, instanceReady: true}},
    ...overrides,
  };
}

test("destination runtime attestation is generation- and receipt-bound", () => {
  const verified = validateDestinationRuntimeEvidence(evidence(), record);
  assert.equal(verified.healthPath, HEALTH_PATH);
  assert.equal(verified.destinationGeneration, 2);
  assert.match(verified.runnerImageRefSha256, /^[a-f0-9]{64}$/);
  for (const patch of [
    {destinationGeneration: 3},
    {diskReceiptSha256: "c".repeat(64)},
    {runtime: {...evidence().runtime, health: {path: "/healthz", status: 200, agentReady: true}}},
    {runtime: {...evidence().runtime, disk: {...evidence().runtime.disk, attached: false}}},
  ]) {
    assert.throws(() => validateDestinationRuntimeEvidence({...evidence(), ...patch}, record),
        /vm_migration_destination_runtime_unverified/);
  }
});

test("cutover review reports verified prerequisites and authorizes the atomic switch", () => {
  const result = cutoverReview(record, {runtimeEvidence: {healthPath: HEALTH_PATH},
    sourceBlockers: ["migration_fence_already_exists"]});
  assert.equal(result.runtimeAttested, true);
  assert.equal(result.readyForCutover, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.sourceAuthority, "legacy");
  assert.equal(result.destinationRetained, true);
  assert.equal(result.nextAction, "switch-authority");
});

test("cutover review keeps incomplete validation and runtime evidence blocked", () => {
  const result = cutoverReview({...record, validation: {}}, {sourceBlockers: ["legacy_upload_sessions_require_drain"]});
  assert.equal(result.readyForCutover, false);
  assert.deepEqual(result.blockers, ["legacy_upload_sessions_require_drain", "validation_cleanup_required",
    "destination_runtime_attestation_unverified"]);
  assert.equal(result.nextAction, "attest-destination-runtime");
});
