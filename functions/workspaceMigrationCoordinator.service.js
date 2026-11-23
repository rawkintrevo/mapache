"use strict";

const {httpError} = require("./backendUtils.helpers");

const MIGRATION_STATES = Object.freeze([
  "preflight", "reserved", "quiescing", "captured", "imported", "switched", "validated", "released", "blocked",
]);
const NEXT_STATE = Object.freeze({
  preflight: "reserved",
  reserved: "quiescing",
  quiescing: "captured",
  captured: "imported",
  imported: "switched",
  switched: "validated",
  validated: "released",
});

function createWorkspaceMigrationCoordinator(dependencies = {}) {
  const now = dependencies.now || (() => new Date().toISOString());
  return {advance, begin, rollback};

  function begin({workspaceId, ownerUid, sourceGeneration, destinationId, operationId}) {
    required(workspaceId, "workspace_id");
    required(ownerUid, "owner_uid");
    required(sourceGeneration, "source_generation");
    required(destinationId, "destination_id");
    required(operationId, "operation_id");
    return {
      version: 1,
      state: "preflight",
      workspaceId,
      ownerUid,
      operationId,
      sourceGeneration,
      destinationId,
      destinationGeneration: null,
      authority: "source",
      progress: {phase: "preflight", completed: false},
      destinationWritesStarted: false,
      sourceRetained: true,
      updatedAt: now(),
    };
  }

  function advance(current, nextState, evidence = {}) {
    assertOperation(current, evidence);
    if (!MIGRATION_STATES.includes(nextState) || nextState === "blocked") throw migrationError("migration_state_invalid");
    if (NEXT_STATE[current.state] !== nextState) throw migrationError("migration_transition_invalid");
    if (nextState === "imported" && !evidence.verified) throw migrationError("migration_import_not_verified");
    if (nextState === "switched" && !evidence.destinationGeneration) throw migrationError("migration_destination_generation_missing");
    if (nextState === "released" && current.authority !== "destination") throw migrationError("migration_authority_not_validated");
    return {
      ...current,
      state: nextState,
      authority: nextState === "switched" || nextState === "validated" || nextState === "released" ? "destination" : current.authority,
      destinationGeneration: evidence.destinationGeneration || current.destinationGeneration,
      destinationWritesStarted: current.destinationWritesStarted || nextState === "imported" || nextState === "switched" || nextState === "validated" || nextState === "released",
      progress: {phase: nextState, completed: nextState === "released", ...(evidence.progress || {})},
      updatedAt: now(),
    };
  }

  function rollback(current, evidence = {}) {
    assertOperation(current, evidence);
    if (current.authority === "source" && !current.destinationWritesStarted) {
      return {...current, state: "released", authority: "source", rollback: {state: "source-restored", verified: true}, updatedAt: now()};
    }
    if (current.destinationWritesStarted && evidence.destinationWritersStopped && evidence.reverseImportVerified) {
      return {...current, state: "released", authority: "source", rollback: {state: "source-restored", verified: true, reverseImport: true}, updatedAt: now()};
    }
    return {
      ...current,
      state: "blocked",
      authority: current.authority,
      rollback: {state: "blocked", reason: "reverse_import_required", sourceRetained: true, destinationRetained: true},
      updatedAt: now(),
    };
  }

  function assertOperation(current, evidence) {
    if (!current || !current.operationId || current.operationId !== evidence.operationId) throw migrationError("migration_operation_conflict");
    if (current.workspaceId !== evidence.workspaceId) throw migrationError("migration_workspace_conflict");
  }
}

function required(value, field) {
  if (!String(value || "").trim()) throw migrationError(`migration_${field}_missing`);
}

function migrationError(code) {
  const error = httpError(409, code);
  error.code = code;
  error.publicMessage = code;
  return error;
}

module.exports = {MIGRATION_STATES, NEXT_STATE, createWorkspaceMigrationCoordinator};
