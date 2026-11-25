"use strict";

const {httpError} = require("./backendUtils.helpers");

const DIGEST = /^[a-f0-9]{64}$/;

function vmMigrationSourceAuditRef(db, workspaceId) {
  return db.collection("vmMigrationSourceAudits_v2").doc(workspaceId);
}

function requireReadyVmMigrationSourceAudit(audit, {workspaceId, ownerUid, sourceGeneration, observationSha256,
  sourceObservationSha256, scope}) {
  if (!audit || audit.schemaVersion !== 1 || audit.state !== "ready" || audit.decision !== "admit-reservation" ||
      audit.workspaceId !== workspaceId || audit.ownerUid !== ownerUid || audit.sourceGeneration !== sourceGeneration ||
      audit.observationSha256 !== observationSha256 || audit.sourceObservationSha256 !== sourceObservationSha256 ||
      JSON.stringify(audit.scope) !== JSON.stringify(scope) || audit.sourceRetained !== true ||
      !DIGEST.test(String(audit.evidenceSha256 || "")) || !Array.isArray(audit.blockers) || audit.blockers.length) {
    throw httpError(409, "vm_migration_source_audit_required");
  }
  return audit;
}

module.exports = {vmMigrationSourceAuditRef, requireReadyVmMigrationSourceAudit};
