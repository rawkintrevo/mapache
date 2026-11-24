"use strict";

const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const {db} = require("./backendContext");
const {createComputeEngineBackupService} = require("./computeEngineBackup.service");
const {createVmBackupSchedulerService} = require("./vmBackupScheduler.service");

const service = createVmBackupSchedulerService({
  db,
  backup: createComputeEngineBackupService({projectId: "pi-agents-cloud"}),
});

// Workspaces opt in by setting backupPolicy.enabled=true on their backend-owned
// VM registry document. The existing Cloud Run path and all VM records without
// that explicit policy remain untouched.
exports.vmBackupReconcile_v2 = onSchedule({schedule: "every 15 minutes",
  serviceAccount: "mapache-api@pi-agents-cloud.iam.gserviceaccount.com",
  timeoutSeconds: 540, memory: "512MiB", maxInstances: 1}, async () => {
  const result = await service.runTick();
  logger.info("VM backup reconciliation complete", result);
  return result;
});

