#!/usr/bin/env node
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const flags = new Set(["--project", "--workspace", "--owner", "--operation"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function parseOptions() {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const [flag, value] = process.argv.slice(index, index + 2);
    if (!flags.has(flag) || !value || options.has(flag)) throw Error("cutover_review_arguments_invalid");
    options.set(flag, value);
  }
  if (options.size !== flags.size || options.get("--project") !== "pi-agents-cloud" ||
      !["--workspace", "--owner", "--operation"].every(flag => IDENTIFIER.test(options.get(flag) || ""))) {
    throw Error("cutover_review_arguments_invalid");
  }
  return options;
}

try {
  const options = parseOptions();
  const admin = require("../functions/node_modules/firebase-admin");
  const {createComputeEngineService} = require("../functions/computeEngine.service.js");
  const {createVmMigrationCoordinator} = require("../functions/vmMigrationCoordinator.service.js");
  const {createVmLifecycleEffects} = require("../functions/vmLifecycle.adapter.js");
  const {createRuntimeDescriptor} = require("../functions/runtimeProvider.helpers.js");
  const app = admin.initializeApp({projectId: "pi-agents-cloud"}, "vm-migration-cutover-review");
  const db = app.firestore();
  const compute = createComputeEngineService({projectId: "pi-agents-cloud"});
  const effects = createVmLifecycleEffects({db, compute});
  const workspaceId = options.get("--workspace");
  const ownerUid = options.get("--owner");
  const operationId = options.get("--operation");
  const inspectDestinationRuntime = async ({record}) => {
    const destination = record.importDestination;
    const runtimeSnapshot = await db.doc(`vmRuntimes_v2/${workspaceId}`).get();
    const runtime = runtimeSnapshot.data();
    if (!runtimeSnapshot.exists || runtime?.ownerUid !== ownerUid || runtime.backend !== "compute-engine" ||
        runtime.generation !== destination.generation || runtime.state !== "active" ||
        !runtime.currentSessionId || !runtime.gatewayHost || !runtime.runnerImage) throw Error("runtime_registry_unverified");
    const sessionSnapshot = await db.doc(`vmRuntimes_v2/${workspaceId}/sessions/${runtime.currentSessionId}`).get();
    const session = sessionSnapshot.data();
    const routeSnapshot = await db.doc(`vmGatewayRoutes_v2/${runtime.gatewayHost}`).get();
    const route = routeSnapshot.data();
    if (!sessionSnapshot.exists || session?.ownerUid !== ownerUid || session.generation !== destination.generation ||
        session.state !== "active" || !routeSnapshot.exists || route?.enabled !== true ||
        route.workspaceId !== workspaceId || route.ownerUid !== ownerUid ||
        route.generation !== destination.generation || route.sessionId !== runtime.currentSessionId) {
      throw Error("runtime_route_unverified");
    }
    const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId, ownerUid,
      region: "us-central1", zone: destination.zone, generation: destination.generation});
    const provider = await compute.inspectMigrationRuntime(descriptor, {operationId: destination.operationId, diskId: destination.diskId});
    const observed = await compute.inspect(descriptor);
    if (!observed.instance?.privateAddress || route.address !== observed.instance.privateAddress) throw Error("runtime_route_target_changed");
    const healthy = await effects.health({gatewayHost: runtime.gatewayHost, sessionId: runtime.currentSessionId,
      ownerUid, descriptor});
    if (!healthy) throw Error("runtime_health_unverified");
    return {
      schemaVersion: 1, workspaceId, ownerUid, migrationOperationId: record.operationId,
      destinationOperationId: destination.operationId, sourceGeneration: record.sourceGeneration,
      destinationGeneration: destination.generation, diskId: destination.diskId, diskName: destination.diskName,
      diskReceiptSha256: record.diskImport.receiptSha256, sessionId: runtime.currentSessionId,
      runtime: {state: runtime.state, generation: runtime.generation, runnerImage: runtime.runnerImage,
        gatewayHost: runtime.gatewayHost, health: {path: "/runner/health", status: 200, agentReady: true},
        disk: {diskId: provider.diskId, diskName: provider.diskName, attached: provider.attached,
          instanceReady: provider.instanceReady}},
    };
  };
  try {
    const coordinator = createVmMigrationCoordinator({db, inspectDestinationRuntime,
      authorize: async (_, action) => action === "review-cutover-gates"});
    console.log(JSON.stringify(await coordinator.reviewCutoverGates({workspaceId, ownerUid, operationId})));
  } finally {
    await app.delete();
  }
} catch (error) {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === "string" && /^(?:cutover_review_|vm_migration_|runtime_migration_|runtime_data_|compute_)[a-z0-9_]+$/.test(code)
    ? code : "cutover_review_failed";
  console.error(JSON.stringify({status: "blocked", reason, readyForCutover: false, sourceRetained: true}));
  process.exitCode = 1;
}
