#!/usr/bin/env node
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const PROJECT = "pi-agents-cloud";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FLAGS = new Set(["--project", "--workspace", "--owner", "--operation", "--confirm", "--receipt"]);

function parseOptions() {
  const action = process.argv[2];
  if (!["begin", "complete"].includes(action)) throw Error("rollback_action_invalid");
  const options = new Map();
  for (let index = 3; index < process.argv.length; index += 2) {
    const [flag, value] = process.argv.slice(index, index + 2);
    if (!FLAGS.has(flag) || !value || options.has(flag)) throw Error("rollback_arguments_invalid");
    options.set(flag, value);
  }
  const required = ["--project", "--workspace", "--owner", "--operation", "--confirm"];
  if (!required.every(flag => options.has(flag)) || options.get("--project") !== PROJECT ||
      !["--workspace", "--owner", "--operation"].every(flag => IDENTIFIER.test(options.get(flag) || "")) ||
      options.get("--confirm") !== `rollback-${action}` ||
      (action === "complete" && !options.has("--receipt")) ||
      (action === "begin" && options.has("--receipt"))) {
    throw Error("rollback_arguments_invalid");
  }
  return {action, options};
}

function inputFrom(options) {
  return {workspaceId: options.get("--workspace"), ownerUid: options.get("--owner"), operationId: options.get("--operation")};
}

async function readReceipt(path) {
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content) > 1024 * 1024) throw Error("reverse_import_receipt_too_large");
  try {
    const receipt = JSON.parse(content);
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw Error("reverse_import_receipt_invalid");
    return receipt;
  } catch (error) {
    if (error.message === "reverse_import_receipt_invalid") throw error;
    throw Error("reverse_import_receipt_invalid");
  }
}

function destinationDescriptor(createRuntimeDescriptor, record, input) {
  const destination = record.importDestination;
  if (!destination) throw Error("rollback_destination_missing");
  return createRuntimeDescriptor({backend: "compute-engine", workspaceId: input.workspaceId, ownerUid: input.ownerUid,
    region: destination.region, zone: destination.zone, generation: destination.generation});
}

try {
  const {action, options} = parseOptions();
  const admin = require("../functions/node_modules/firebase-admin");
  const {createComputeEngineService} = require("../functions/computeEngine.service.js");
  const {createVmMigrationCoordinator} = require("../functions/vmMigrationCoordinator.service.js");
  const {createRuntimeDescriptor} = require("../functions/runtimeProvider.helpers.js");
  const app = admin.initializeApp({projectId: PROJECT}, "vm-migration-rollback");
  const db = app.firestore();
  const compute = createComputeEngineService({projectId: PROJECT});
  const input = inputFrom(options);
  try {
    if (action === "begin") {
      const coordinator = createVmMigrationCoordinator({db,
        authorize: async (_, requestedAction) => requestedAction === "begin-rollback"});
      const result = await coordinator.beginRollback(input);
      if (result.phase === "rollback-draining") {
        const operation = await db.doc(`vmMigrationOperations_v2/${input.workspaceId}/operations/${input.operationId}`).get();
        const record = operation.data();
        const descriptor = destinationDescriptor(createRuntimeDescriptor, record, input);
        const observed = await compute.inspect(descriptor);
        if (observed.instance) {
          await compute.inspectMigrationRuntime(descriptor, {operationId: record.importDestination.operationId,
            diskId: record.importDestination.diskId});
          await compute.deleteOwnedInstance(descriptor, {operationId: `${input.operationId}-rollback`, timeoutMs: 240000});
        }
        const disk = await compute.inspectMigrationDisk(descriptor, {operationId: record.importDestination.operationId});
        if (disk.diskId !== record.importDestination.diskId) throw Error("rollback_destination_disk_changed");
        console.log(JSON.stringify({...result, destinationStopped: true, destinationDiskId: disk.diskId}));
      } else {
        console.log(JSON.stringify(result));
      }
    } else {
      const receipt = await readReceipt(options.get("--receipt"));
      const inspectDestinationRollback = async ({record}) => {
        const destination = record.importDestination;
        const runtimeSnapshot = await db.doc(`vmRuntimes_v2/${input.workspaceId}`).get();
        const runtime = runtimeSnapshot.data() || {};
        const sessionId = runtime.currentSessionId;
        const sessionSnapshot = await db.doc(`vmRuntimes_v2/${input.workspaceId}/sessions/${sessionId || "invalid"}`).get();
        const session = sessionSnapshot.data() || {};
        const routeSnapshot = await db.doc(`vmGatewayRoutes_v2/${runtime.gatewayHost || "invalid"}`).get();
        const route = routeSnapshot.data() || {};
        const descriptor = destinationDescriptor(createRuntimeDescriptor, record, input);
        const [observed, disk] = await Promise.all([
          compute.inspect(descriptor),
          compute.inspectMigrationDisk(descriptor, {operationId: destination.operationId}),
        ]);
        if (observed.instance || disk.diskId !== destination.diskId || disk.diskName !== destination.diskName) {
          throw Error("rollback_destination_not_stopped");
        }
        return {schemaVersion: 1, workspaceId: input.workspaceId, ownerUid: input.ownerUid,
          migrationOperationId: input.operationId, destinationGeneration: destination.generation,
          diskId: disk.diskId, diskName: disk.diskName, sessionId,
          runtime: {state: "stopped", instanceAbsent: true, disk: {diskId: disk.diskId, diskName: disk.diskName, attached: false}},
          registry: {apiEnabled: runtime.apiEnabled, state: runtime.state, generation: runtime.generation, currentSessionId: sessionId},
          session: {state: session.state, generation: session.generation},
          route: {enabled: route.enabled, generation: route.generation, sessionId: route.sessionId}};
      };
      const coordinator = createVmMigrationCoordinator({db, inspectDestinationRollback,
        authorize: async (_, requestedAction) => requestedAction === "complete-rollback"});
      console.log(JSON.stringify(await coordinator.completeRollback({...input, reverseImport: receipt})));
    }
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === "string" && /^(?:rollback_|reverse_import_|vm_migration_|runtime_migration_|runtime_data_|compute_)[a-z0-9_]+$/.test(code)
    ? code : "rollback_failed";
  console.error(JSON.stringify({status: "blocked", reason, sourceRetained: true, destinationRetained: true}));
  process.exitCode = 1;
}
