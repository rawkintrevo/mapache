"use strict";

const {createHash} = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");

const DIGEST = /^[a-f0-9]{64}$/;

function vmMigrationSourceAuditRef(db, workspaceId) {
  return db.collection("vmMigrationSourceAudits_v2").doc(workspaceId);
}

function sourceAuditEvidenceSha256(audit) {
  return createHash("sha256").update(JSON.stringify({schemaVersion: audit.schemaVersion,
    state: audit.state, decision: audit.decision, workspaceId: audit.workspaceId, ownerUid: audit.ownerUid,
    sourceGeneration: audit.sourceGeneration, observationSha256: audit.observationSha256,
    sourceObservationSha256: audit.sourceObservationSha256, scope: audit.scope, blockers: audit.blockers,
    sourceRetained: audit.sourceRetained, completeness: audit.completeness})).digest("hex");
}

function requireReadyVmMigrationSourceAudit(audit, {workspaceId, ownerUid, sourceGeneration, observationSha256,
  sourceObservationSha256, scope}) {
  if (!audit || audit.schemaVersion !== 1 || audit.state !== "ready" || audit.decision !== "admit-reservation" ||
      audit.workspaceId !== workspaceId || audit.ownerUid !== ownerUid || audit.sourceGeneration !== sourceGeneration ||
      audit.observationSha256 !== observationSha256 || audit.sourceObservationSha256 !== sourceObservationSha256 ||
      JSON.stringify(audit.scope) !== JSON.stringify(scope) || audit.sourceRetained !== true ||
      !audit.completeness || !DIGEST.test(String(audit.evidenceSha256 || "")) ||
      audit.evidenceSha256 !== sourceAuditEvidenceSha256(audit) || !Array.isArray(audit.blockers) || audit.blockers.length) {
    throw httpError(409, "vm_migration_source_audit_required");
  }
  return audit;
}

module.exports = {vmMigrationSourceAuditRef, requireReadyVmMigrationSourceAudit, sourceAuditEvidenceSha256};
