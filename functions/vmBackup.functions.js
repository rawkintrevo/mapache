"use strict";

const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const {db} = require("./backendContext");
const {createComputeEngineService} = require("./computeEngine.service");
const {createComputeEngineBackupService} = require("./computeEngineBackup.service");
const {createVmBackupInventoryService} = require("./vmBackupInventory.service");
const {createVmBackupSchedulerService} = require("./vmBackupScheduler.service");

const backup = createComputeEngineBackupService({projectId: "pi-agents-cloud"});
const compute = createComputeEngineService({projectId: "pi-agents-cloud"});
const service = createVmBackupSchedulerService({db, backup});
const inventory = createVmBackupInventoryService({db, provider: {inspect: compute.inspect, listSnapshots: backup.listSnapshots}});

// Workspaces opt in by setting backupPolicy.enabled=true on their backend-owned
// VM registry document. The existing Cloud Run path and all VM records without
// that explicit policy remain untouched.
exports.vmBackupReconcile_v2 = onSchedule({schedule: "every 15 minutes",
  serviceAccount: "mapache-api@pi-agents-cloud.iam.gserviceaccount.com",
  timeoutSeconds: 540, memory: "512MiB", maxInstances: 1}, async () => {
  const result = await service.runTick();
  const inventoryResult = await inventory.runTick();
  logger.info("VM backup reconciliation complete", {...result, inventory: inventoryResult});
  return {...result, inventory: inventoryResult};
});

