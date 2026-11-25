"use strict";

const {createHash} = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");

const HEALTH_PATH = "/runner/health";
const DESTINATION_AUTHORITY = "compute-engine";
const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HOST = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const RUNNER_IMAGE = /^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/;

function invalid() {
  throw httpError(409, "vm_migration_destination_runtime_unverified");
}

function validateDestinationRuntimeEvidence(evidence, record) {
  const destination = record?.importDestination;
  const runtime = evidence?.runtime;
  const health = runtime?.health;
  const disk = runtime?.disk;
  if (!destination || evidence?.schemaVersion !== 1 ||
      evidence.workspaceId !== record.workspaceId || evidence.ownerUid !== record.ownerUid ||
      evidence.migrationOperationId !== record.operationId ||
      evidence.destinationOperationId !== destination.operationId ||
      evidence.sourceGeneration !== record.sourceGeneration ||
      evidence.destinationGeneration !== destination.generation ||
      evidence.diskId !== destination.diskId || evidence.diskName !== destination.diskName ||
      !IDENTIFIER.test(String(evidence.sessionId || "")) ||
      !RUNNER_IMAGE.test(String(runtime?.runnerImage || "")) ||
      !HOST.test(String(runtime?.gatewayHost || "")) ||
      runtime?.state !== "active" || runtime?.generation !== destination.generation ||
      health?.path !== HEALTH_PATH || health.status !== 200 || health.agentReady !== true ||
      disk?.diskId !== destination.diskId || disk.diskName !== destination.diskName ||
      disk.attached !== true || disk.instanceReady !== true ||
      evidence.diskReceiptSha256 !== record.diskImport?.receiptSha256 ||
      !DIGEST.test(String(evidence.diskReceiptSha256 || ""))) invalid();

  return {
    schemaVersion: 1,
    workspaceId: record.workspaceId,
    ownerUid: record.ownerUid,
    migrationOperationId: record.operationId,
    destinationOperationId: destination.operationId,
    sourceGeneration: record.sourceGeneration,
    destinationGeneration: destination.generation,
    diskId: destination.diskId,
    diskName: destination.diskName,
    diskReceiptSha256: evidence.diskReceiptSha256,
    sessionId: evidence.sessionId,
    runnerImageRefSha256: createHash("sha256").update(runtime.runnerImage).digest("hex"),
    healthPath: HEALTH_PATH,
    healthStatus: health.status,
    agentReady: health.agentReady,
  };
}

function cutoverReview(record, {runtimeEvidence, sourceBlockers = []} = {}) {
  const blockers = [...new Set(sourceBlockers.filter(blocker =>
    !["migration_fence_already_exists", "destination_registry_exists"].includes(blocker)))];
  if (record?.phase !== "disk-import-verified") blockers.push("disk_import_not_verified");
  if (record?.validation?.cleanedAtMs === undefined) blockers.push("validation_cleanup_required");
  if (!record?.diskImport?.receiptSha256 || !DIGEST.test(record.diskImport.receiptSha256)) {
    blockers.push("disk_import_receipt_missing");
  }
  if (!runtimeEvidence) blockers.push("destination_runtime_attestation_unverified");
  if (!blockers.length) {
    return {
      workspaceId: record.workspaceId,
      operationId: record.operationId,
      phase: record.phase,
      sourceGeneration: record.sourceGeneration,
      destinationGeneration: record.importDestination.generation,
      sourceAuthority: "legacy",
      destinationRetained: true,
      readyForCutover: true,
      blockers: [],
      runtimeAttested: true,
      nextAction: "switch-authority",
    };
  }
  return {
    workspaceId: record?.workspaceId ?? null,
    operationId: record?.operationId ?? null,
    phase: record?.phase ?? null,
    sourceGeneration: record?.sourceGeneration ?? null,
    destinationGeneration: record?.importDestination?.generation ?? null,
    sourceAuthority: "legacy",
    destinationRetained: true,
    readyForCutover: false,
    blockers: [...new Set(blockers)],
    runtimeAttested: Boolean(runtimeEvidence),
    nextAction: runtimeEvidence ? "resolve-cutover-blockers" : "attest-destination-runtime",
  };
}

module.exports = {DESTINATION_AUTHORITY, HEALTH_PATH, cutoverReview, validateDestinationRuntimeEvidence};
