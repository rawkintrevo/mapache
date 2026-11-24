"use strict";

const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const {db} = require("./backendContext");
const {createComputeEngineService} = require("./computeEngine.service");
const {createComputeEngineBackupService} = require("./computeEngineBackup.service");
const {createVmBackupInventoryService} = require("./vmBackupInventory.service");
const {createVmBackupRuntimeEvidenceService} = require("./vmBackupRuntimeEvidence.service");
const {createVmBackupRecoveryRuntimeService} = require("./vmBackupRecoveryRuntime.service");
const {createVmBackupRecoveryService} = require("./vmBackupRecovery.service");
const {createVmBackupSchedulerService} = require("./vmBackupScheduler.service");

const backup = createComputeEngineBackupService({projectId: "pi-agents-cloud"});
const compute = createComputeEngineService({projectId: "pi-agents-cloud"});
const runtimeEvidence = createVmBackupRuntimeEvidenceService({db});
const service = createVmBackupSchedulerService({db, backup, captureRuntimeEvidence: runtimeEvidence.capture});
const recoveryRuntime = createVmBackupRecoveryRuntimeService({db, compute});
const recovery = createVmBackupRecoveryService({db, backup, restoreRuntime: recoveryRuntime});
const inventory = createVmBackupInventoryService({db, provider: {
  inspect: compute.inspect, listOwnedResources: compute.listOwnedResources, listSnapshots: backup.listSnapshots,
}});

// Workspaces opt in by setting backupPolicy.enabled=true on their backend-owned
// VM registry document. The existing Cloud Run path and all VM records without
// that explicit policy remain untouched.
exports.vmBackupReconcile_v2 = onSchedule({schedule: "every 15 minutes",
  serviceAccount: "mapache-api@pi-agents-cloud.iam.gserviceaccount.com",
  timeoutSeconds: 540, memory: "512MiB", maxInstances: 1}, async () => {
  const result = await service.runTick();
  const recoveryResult = await recovery.runTick();
  const inventoryResult = await inventory.runTick();
  logger.info("VM backup reconciliation complete", {...result, recovery: recoveryResult, inventory: inventoryResult});
  return {...result, recovery: recoveryResult, inventory: inventoryResult};
});

// The authenticated VM API delegates restore reservation here so the same
// durable recovery controller is used by both user requests and the scheduler.
exports.requestVmBackupRestore = (input) => recovery.requestRestore(input);

