"use strict";

const {randomBytes} = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const {tokenHash, VALIDATION_COLLECTION} = require("./vmRuntimeControl.service");

const VALIDATION_BOOT_MS = 30 * 60 * 1000;

async function reserveValidationRuntime({db, transaction, record, now}) {
  const {ownerUid, workspaceId, operationId: migrationOperationId, importDestination, validation} = record;
  const {generation} = importDestination;
  const sessionId = validation.operationId.replace(/^validate-/, "validation-");
  const workspaceRef = db.collection(VALIDATION_COLLECTION).doc(workspaceId);
  const sessionRef = workspaceRef.collection("sessions").doc(sessionId);
  const credentialRef = db.collection("vmMigrationValidationCredentials_v2").doc(sessionId);
  const [workspace, session, saved] = await Promise.all([
    transaction.get(workspaceRef), transaction.get(sessionRef), transaction.get(credentialRef),
  ]);
  const identity = {ownerUid, generation, migrationOperationId};
  if (validation.bootRequestedAtMs !== undefined) {
    const credentials = saved.data();
    if (![workspace, session, saved].every(snapshot => snapshot.exists &&
        Object.keys(identity).every(key => snapshot.get(key) === identity[key])) ||
        workspace.get("currentSessionId") !== sessionId || workspace.get("deadlineMs") !== validation.deadlineMs ||
        workspace.get("apiEnabled") !== false || workspace.get("lifecycleEnabled") !== false ||
        !/^[a-f0-9]{64}$/.test(credentials?.controlToken || "") ||
        session.get("controlTokenHash") !== tokenHash(credentials.controlToken)) {
      throw httpError(409, "vm_migration_validation_runtime_conflict");
    }
    if (validation.deadlineMs <= now) throw httpError(409, "vm_migration_validation_deadline_expired");
    return {sessionId, credentials, deadlineMs: validation.deadlineMs};
  }
  if ([workspace, session, saved].some(snapshot => snapshot.exists)) throw httpError(409, "vm_migration_validation_runtime_conflict");
  const token = () => randomBytes(32).toString("hex");
  const credentials = {controlToken: token(), browserToken: token(), shutdownToken: token()};
  const deadlineMs = now + VALIDATION_BOOT_MS;
  transaction.create(workspaceRef, {...identity, backend: "compute-engine", state: "reserved", deadlineMs,
    currentSessionId: sessionId, apiEnabled: false, lifecycleEnabled: false, leaseExpiresAt: 0});
  transaction.create(sessionRef, {...identity, state: "reserved", controlTokenHash: tokenHash(credentials.controlToken), leaseExpiresAt: 0});
  transaction.create(credentialRef, {...identity, ...credentials});
  return {sessionId, credentials, deadlineMs};
}

module.exports = {reserveValidationRuntime};
