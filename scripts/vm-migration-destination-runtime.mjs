#!/usr/bin/env node
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {
  CONTROL_URL,
  PROJECT_ID,
  REGION,
  RUNNER_IMAGE,
  SUBNETWORK,
  createDestinationSeed,
  parseDestinationRuntimeArgs,
  parseGatewayUrl,
  safeDestinationStatus,
} from "./lib/vm-migration-destination-runtime.mjs";

const require = createRequire(import.meta.url);
const admin = require("../functions/node_modules/firebase-admin");
const {createComputeEngineService} = require("../functions/computeEngine.service.js");
const {createRuntimeDescriptor} = require("../functions/runtimeProvider.helpers.js");

const SAFE_REASON = /^(?:destination_runtime_|runtime_|compute_|vm_migration_|vm_|gateway_)[a-z0-9_]+$/;
const START_TIMEOUT_MS = 10 * 60 * 1000;

function inputFrom(options) {
  return {workspaceId: options.get("--workspace"), ownerUid: options.get("--owner"), operationId: options.get("--operation")};
}

function gatewayUrl(options) {
  const supplied = options.get("--gateway-url");
  const raw = supplied || execFileSync("gcloud", ["run", "services", "describe", "mapache-vm-gateway-v2",
    "--region", REGION, "--project", PROJECT_ID, "--format=value(status.url)"], {encoding: "utf8"}).trim();
  return parseGatewayUrl(raw);
}

function operationRef(db, input) {
  return db.doc(`vmMigrationOperations_v2/${input.workspaceId}/operations/${input.operationId}`);
}

function runtimeRef(db, input) {
  return db.doc(`vmRuntimes_v2/${input.workspaceId}`);
}

function destinationDescriptor(input, record) {
  const destination = record.importDestination;
  if (!destination) throw Error("destination_runtime_disk_missing");
  return createRuntimeDescriptor({backend: "compute-engine", workspaceId: input.workspaceId, ownerUid: input.ownerUid,
    region: destination.region, zone: destination.zone, generation: destination.generation, dataDiskName: destination.diskName});
}

function storageFenceRef(db, record, ownerUid) {
  return db.collection("vmMigrationStorageFences_v2").doc(record.scope.bucket).collection("owners").doc(ownerUid)
      .collection("prefixes").doc(record.scope.workspaceKey);
}

function assertOperationSource(record, source, fence, storageFence, input) {
  if (record.workspaceId !== input.workspaceId || record.ownerUid !== input.ownerUid || record.operationId !== input.operationId ||
      record.phase !== "disk-import-verified" || record.validation?.cleanedAtMs === undefined || record.destinationCleanup?.cleanedAtMs !== undefined ||
      !record.importDestination?.diskId || !record.importDestination?.diskName ||
      source.ownerUid !== input.ownerUid || source.agentRuntimeGeneration !== record.sourceGeneration || source.agentRuntimeBootInstanceId ||
      source.migrationAuthority === "compute-engine" ||
      !fence.exists || fence.get("workspaceId") !== input.workspaceId || fence.get("ownerUid") !== input.ownerUid ||
      fence.get("operationId") !== input.operationId || !storageFence.exists || storageFence.get("workspaceId") !== input.workspaceId ||
      storageFence.get("ownerUid") !== input.ownerUid || storageFence.get("operationId") !== input.operationId) {
    throw Error("destination_runtime_source_not_ready");
  }
}

async function readContext(db, input) {
  const operation = await operationRef(db, input).get();
  if (!operation.exists || operation.get("ownerUid") !== input.ownerUid) throw Error("vm_migration_operation_not_found");
  const record = operation.data();
  const runtime = await runtimeRef(db, input).get();
  if (!runtime.exists) return {record, runtime, session: null, credentials: null, route: null};
  const runtimeData = runtime.data();
  if (runtimeData.ownerUid !== input.ownerUid || runtimeData.migrationOperationId !== input.operationId ||
      runtimeData.backend !== "compute-engine") throw Error("destination_runtime_identity_mismatch");
  const session = await runtimeRef(db, input).collection("sessions").doc(runtimeData.currentSessionId || "invalid").get();
  const credentials = await db.doc(`vmRuntimeCredentials_v2/${runtimeData.currentSessionId || "invalid"}`).get();
  const route = await db.collection("vmGatewayRoutes_v2").doc(runtimeData.gatewayHost || "invalid").get();
  return {record, runtime, session, credentials, route};
}

async function reserveDestination(db, input, runnerImage, gatewayHost) {
  const operation = operationRef(db, input);
  const runtime = runtimeRef(db, input);
  const initial = await readContext(db, input);
  if (initial.record.phase !== "disk-import-verified" || initial.record.validation?.cleanedAtMs === undefined ||
      initial.record.destinationCleanup?.cleanedAtMs !== undefined) {
    throw Error("destination_runtime_source_not_ready");
  }
  if (initial.runtime.exists) {
    const runtimeData = initial.runtime.data();
    if (runtimeData.apiEnabled === true || runtimeData.migrationAuthority !== "legacy" || !initial.session.exists ||
        !initial.credentials.exists || !initial.route.exists || initial.route.get("workspaceId") !== input.workspaceId ||
        initial.route.get("ownerUid") !== input.ownerUid || initial.route.get("migrationOperationId") !== input.operationId) {
      throw Error("destination_runtime_already_admitted");
    }
    if (runtimeData.runnerImage !== runnerImage || runtimeData.gatewayHost !== gatewayHost) {
      throw Error("destination_runtime_configuration_conflict");
    }
    return initial;
  }

  return db.runTransaction(async tx => {
    const [operationSnapshot, source, fence, storageFence, existingRuntime, existingRoute] = await Promise.all([
      tx.get(operation), tx.get(db.doc(`workspaces/${input.workspaceId}`)), tx.get(db.doc(`vmMigrationFences_v2/${input.workspaceId}`)),
      tx.get(storageFenceRef(db, initial.record, input.ownerUid)), tx.get(runtime),
      tx.get(db.collection("vmGatewayRoutes_v2").doc(gatewayHost)),
    ]);
    const record = operationSnapshot.data();
    if (!operationSnapshot.exists) throw Error("vm_migration_operation_not_found");
    assertOperationSource(record, source.data() || {}, fence, storageFence, input);
    if (existingRuntime.exists || existingRoute.exists) throw Error("destination_runtime_resource_conflict");
    const destination = record.importDestination;
    const seed = createDestinationSeed({workspaceId: input.workspaceId, ownerUid: input.ownerUid,
      operationId: input.operationId, sourceGeneration: record.sourceGeneration, destination,
      runnerImage, gatewayHost});
    const session = runtime.collection("sessions").doc(seed.sessionId);
    const credentials = db.collection("vmRuntimeCredentials_v2").doc(seed.sessionId);
    tx.create(runtime, seed.runtime);
    tx.create(session, seed.session);
    tx.create(credentials, seed.credentials);
    tx.create(db.collection("vmGatewayRoutes_v2").doc(gatewayHost), seed.route);
    tx.update(operation, {destinationRuntime: seed.operation, updatedAtMs: seed.operation.createdAtMs});
    return {record: {...record, destinationRuntime: seed.operation}, runtime: {exists: true, data: () => seed.runtime},
      session: {exists: true, data: () => seed.session}, credentials: {exists: true, data: () => seed.credentials},
      route: {exists: true, data: () => seed.route}};
  });
}

function runnerEnvironment(seed) {
  const credentials = seed.credentials.data ? seed.credentials.data() : seed.credentials;
  return {
    MAPACHE_VM_CONTROL_URL: CONTROL_URL,
    MAPACHE_VM_CONTROL_TOKEN: credentials.controlToken,
    SESSION_ID: seed.sessionId,
    SESSION_BROWSER_TOKEN_SECRET: credentials.browserToken,
    SESSION_SHUTDOWN_TOKEN: credentials.shutdownToken,
    MAPACHE_PI_MODEL_CATALOG_REFRESH: "false",
    RUNNER_CAPABILITIES: JSON.stringify({terminal: true, preview: true, previewQa: true, functions: true, chrome: true}),
  };
}

async function setRouteEnabled(db, input, context, address) {
  const runtimeData = context.runtime.data();
  const routeRef = db.collection("vmGatewayRoutes_v2").doc(runtimeData.gatewayHost);
  const runtimeDocument = runtimeRef(db, input);
  await db.runTransaction(async tx => {
    const [runtime, session, route] = await Promise.all([tx.get(runtimeDocument), tx.get(runtimeDocument.collection("sessions").doc(runtimeData.currentSessionId)), tx.get(routeRef)]);
    const ws = runtime.data() || {};
    const ss = session.data() || {};
    const rr = route.data() || {};
    if (!runtime.exists || ws.ownerUid !== input.ownerUid || ws.migrationOperationId !== input.operationId ||
        ws.currentSessionId !== runtimeData.currentSessionId || ss.ownerUid !== input.ownerUid || ss.generation !== ws.generation ||
        rr.workspaceId !== input.workspaceId || rr.ownerUid !== input.ownerUid || rr.migrationOperationId !== input.operationId ||
        rr.generation !== ws.generation || rr.sessionId !== ws.currentSessionId ||
        (rr.enabled === true && rr.address !== address)) {
      throw Error("destination_runtime_route_authority_lost");
    }
    if (rr.enabled !== true || rr.address !== address) tx.update(routeRef, {enabled: true, address});
  });
}

async function resetReservation(db, input, context) {
  const runtimeData = context.runtime.data();
  const runtime = runtimeRef(db, input);
  const session = runtime.collection("sessions").doc(runtimeData.currentSessionId);
  const route = db.collection("vmGatewayRoutes_v2").doc(runtimeData.gatewayHost);
  await db.runTransaction(async tx => {
    const [currentRuntime, currentSession, currentRoute] = await Promise.all([tx.get(runtime), tx.get(session), tx.get(route)]);
    const ws = currentRuntime.data() || {};
    const ss = currentSession.data() || {};
    const rr = currentRoute.data() || {};
    if (!currentRuntime.exists || ws.ownerUid !== input.ownerUid || ws.migrationOperationId !== input.operationId ||
        ws.apiEnabled === true || ws.migrationAuthority !== "legacy" || ss.ownerUid !== input.ownerUid ||
        rr.workspaceId !== input.workspaceId || rr.ownerUid !== input.ownerUid || rr.migrationOperationId !== input.operationId) {
      throw Error("destination_runtime_authority_changed");
    }
    tx.update(runtime, {state: "reserved", bootId: null, leaseExpiresAt: 0});
    tx.update(session, {state: "reserved", bootId: null, leaseExpiresAt: 0});
    tx.update(route, {enabled: false});
  });
}

async function waitForReady({db, input, gateway, context, timeoutMs = START_TIMEOUT_MS}) {
  const until = Date.now() + timeoutMs;
  const credentials = context.credentials.data();
  while (Date.now() < until) {
    const runtime = await runtimeRef(db, input).get();
    const data = runtime.data() || {};
    if (runtime.exists && data.state === "active" && data.bootId && data.leaseExpiresAt > Date.now()) {
      try {
        const response = await fetch(new URL("/runner/health", gateway.url), {redirect: "error", headers: {
          host: gateway.host, "x-shutdown-token": credentials.shutdownToken,
        }, signal: AbortSignal.timeout(15000)});
        if (response.ok) {
          const body = await response.json();
          if (body?.workspaceId === input.workspaceId && body?.sessionId === data.currentSessionId && body?.agentRuntime?.ready === true) {
            return {status: response.status, agentReady: true};
          }
        } else await response.body?.cancel();
      } catch {
        // The bounded loop keeps the exact destination retained for cleanup.
      }
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(1, until - Date.now()))));
  }
  throw Error("destination_runtime_health_timeout");
}

async function markReady(db, input, health) {
  await db.runTransaction(async tx => {
    const op = await tx.get(operationRef(db, input));
    const record = op.data() || {};
    if (!op.exists || record.ownerUid !== input.ownerUid || record.phase !== "disk-import-verified") throw Error("destination_runtime_operation_changed");
    tx.update(operationRef(db, input), {destinationRuntime: {...(record.destinationRuntime || {}), state: "ready", health, readyAtMs: Date.now()}, updatedAtMs: Date.now()});
  });
}

async function startDestination({db, compute, input, options}) {
  const gateway = gatewayUrl(options);
  const runnerImage = options.get("--runner-image");
  const context = await reserveDestination(db, input, runnerImage, gateway.host);
  const record = context.record;
  const descriptor = destinationDescriptor(input, record);
  const destination = record.importDestination;
  const disk = await compute.inspectMigrationDisk(descriptor, {operationId: destination.operationId});
  if (disk.diskId !== destination.diskId || disk.diskName !== destination.diskName) throw Error("destination_runtime_disk_changed");
  const observed = await compute.inspect(descriptor);
  if (!observed.instance) {
    if (context.runtime.data().state !== "reserved") {
      await resetReservation(db, input, context);
      context = await readContext(db, input);
    }
    await compute.start(descriptor, {operationId: destination.operationId, runnerImage, allowCreateDisk: false,
      subnetwork: SUBNETWORK, timeoutMs: 240000, env: runnerEnvironment({sessionId: context.runtime.data().currentSessionId, credentials: context.credentials})});
  } else {
    await compute.inspectMigrationRuntime(descriptor, {operationId: destination.operationId, diskId: destination.diskId});
  }
  const current = await compute.inspect(descriptor);
  if (!current.instance?.privateAddress) throw Error("destination_runtime_private_address_missing");
  await setRouteEnabled(db, input, context, current.instance.privateAddress);
  const health = await waitForReady({db, input, gateway, context});
  await markReady(db, input, health);
  const runtime = await runtimeRef(db, input).get();
  return safeDestinationStatus({workspaceId: input.workspaceId, operationId: input.operationId,
    destinationGeneration: destination.generation, sessionId: runtime.get("currentSessionId"), state: runtime.get("state"), health: true});
}

async function disableRoute(db, input, context) {
  const runtimeData = context.runtime.data();
  const routeRef = db.collection("vmGatewayRoutes_v2").doc(runtimeData.gatewayHost);
  await db.runTransaction(async tx => {
    const route = await tx.get(routeRef);
    const data = route.data() || {};
    if (route.exists && (data.workspaceId !== input.workspaceId || data.ownerUid !== input.ownerUid ||
        data.migrationOperationId !== input.operationId || data.sessionId !== runtimeData.currentSessionId)) {
      throw Error("destination_runtime_route_identity_mismatch");
    }
    if (route.exists) tx.update(routeRef, {enabled: false});
    tx.update(runtimeRef(db, input), {state: "stopping", apiEnabled: false, lifecycleEnabled: false});
    tx.update(runtimeRef(db, input).collection("sessions").doc(runtimeData.currentSessionId), {state: "stopping"});
  });
}

async function cleanupDestination({db, compute, input, options}) {
  const context = await readContext(db, input);
  if (!context.runtime.exists) return {status: "cleaned", workspaceId: input.workspaceId, operationId: input.operationId,
    destinationDiskRetained: true, sourceRetained: true};
  const runtimeData = context.runtime.data();
  if (runtimeData.apiEnabled === true || runtimeData.migrationAuthority !== "legacy") throw Error("destination_runtime_authority_changed");
  const record = context.record;
  const destination = record.importDestination;
  const descriptor = destinationDescriptor(input, record);
  let gateway;
  try { gateway = gatewayUrl(options); } catch {}
  if (gateway && context.credentials.exists && context.route.get("enabled") === true) {
    try {
      await fetch(new URL("/shutdown", gateway.url), {method: "POST", redirect: "error", headers: {
        host: gateway.host, "x-shutdown-token": context.credentials.get("shutdownToken"),
      }, signal: AbortSignal.timeout(30000)});
    } catch {}
  }
  await disableRoute(db, input, context);
  const observed = await compute.inspect(descriptor);
  if (observed.instance) {
    await compute.inspectMigrationRuntime(descriptor, {operationId: destination.operationId, diskId: destination.diskId});
    await compute.deleteOwnedInstance(descriptor, {operationId: `${input.operationId}-destination-cleanup`, timeoutMs: 240000});
  }
  const disk = await compute.inspectMigrationDisk(descriptor, {operationId: destination.operationId});
  if (disk.diskId !== destination.diskId || disk.diskName !== destination.diskName) throw Error("destination_runtime_disk_changed");
  const runtime = runtimeRef(db, input);
  const session = runtime.collection("sessions").doc(runtimeData.currentSessionId);
  const credentials = db.collection("vmRuntimeCredentials_v2").doc(runtimeData.currentSessionId);
  const route = db.collection("vmGatewayRoutes_v2").doc(runtimeData.gatewayHost);
  await db.runTransaction(async tx => {
    const [operation, currentRuntime, currentSession, currentRoute] = await Promise.all([tx.get(operationRef(db, input)), tx.get(runtime), tx.get(session), tx.get(route)]);
    const current = currentRuntime.data() || {};
    if (!operation.exists || !currentRuntime.exists || current.ownerUid !== input.ownerUid || current.migrationOperationId !== input.operationId ||
        current.apiEnabled === true || current.migrationAuthority !== "legacy" || currentSession.data()?.ownerUid !== input.ownerUid ||
        (currentRoute.exists && (currentRoute.get("workspaceId") !== input.workspaceId || currentRoute.get("ownerUid") !== input.ownerUid ||
          currentRoute.get("migrationOperationId") !== input.operationId))) throw Error("destination_runtime_authority_changed");
    tx.delete(credentials);
    tx.delete(session);
    tx.delete(runtime);
    if (currentRoute.exists) tx.delete(route);
    tx.update(operationRef(db, input), {destinationRuntime: {...(operation.data().destinationRuntime || {}), state: "cleaned",
      cleanedAtMs: Date.now()}, updatedAtMs: Date.now()});
  });
  return {status: "cleaned", workspaceId: input.workspaceId, operationId: input.operationId,
    destinationGeneration: destination.generation, destinationDiskRetained: true, sourceRetained: true};
}

async function main() {
  const {action, options} = parseDestinationRuntimeArgs(process.argv.slice(2));
  const app = admin.initializeApp({projectId: PROJECT_ID}, "vm-migration-destination-runtime");
  const db = app.firestore();
  const compute = createComputeEngineService({projectId: PROJECT_ID});
  const input = inputFrom(options);
  try {
    const result = action === "start" ? await startDestination({db, compute, input, options}) :
      await cleanupDestination({db, compute, input, options});
    console.log(JSON.stringify(result));
  } finally {
    await app.delete();
  }
}

main().catch(error => {
  const code = error.publicMessage || error.code || error.message;
  const reason = typeof code === "string" && SAFE_REASON.test(code) ? code : "destination_runtime_failed";
  console.error(JSON.stringify({status: "blocked", reason, sourceRetained: true, destinationDiskRetained: true}));
  process.exitCode = 1;
});
