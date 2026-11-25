#!/usr/bin/env node
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";

const require = createRequire(import.meta.url);
const admin = require("../functions/node_modules/firebase-admin");
const {createComputeEngineService} = require("../functions/computeEngine.service.js");
const {createVmMigrationCoordinator} = require("../functions/vmMigrationCoordinator.service.js");
const {createRuntimeDescriptor} = require("../functions/runtimeProvider.helpers.js");
const {VALIDATION_COLLECTION} = require("../functions/vmRuntimeControl.service.js");

const PROJECT = "pi-agents-cloud";
const STORAGE_BUCKET = "pi-agents-cloud.firebasestorage.app";
const REGION = "us-central1";
const GATEWAY_SERVICE = "mapache-vm-gateway-v2";
const CONTROL_URL = `https://${REGION}-${PROJECT}.cloudfunctions.net/vmMigrationValidationControl_v2`;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUNNER_IMAGE = /^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/;
const VALIDATION_OPERATION = /^validate-([a-f0-9]{24})$/;
const SAFE_REASONS = /^(?:vm_|runtime_|compute_|validation_|migration_|not_found|method_|invalid_)[a-z0-9_]+$/;

function parseArgs(argv) {
  const action = argv.shift();
  if (!["run", "cleanup"].includes(action)) throw Error("validation_boot_action_required");
  const allowed = new Set(["--project", "--workspace", "--owner", "--operation", "--runner-image", "--gateway-url", "--timeout-ms"]);
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || options.has(flag)) throw Error("validation_boot_arguments_invalid");
    options.set(flag, value);
  }
  if (options.get("--project") !== PROJECT || !IDENTIFIER.test(options.get("--workspace") || "") ||
      !IDENTIFIER.test(options.get("--owner") || "") || !IDENTIFIER.test(options.get("--operation") || "")) {
    throw Error("validation_boot_arguments_invalid");
  }
  if (action === "run" && !RUNNER_IMAGE.test(options.get("--runner-image") || "")) throw Error("validation_boot_image_invalid");
  const timeoutMs = Number(options.get("--timeout-ms") || 10 * 60 * 1000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 30 * 60 * 1000) throw Error("validation_boot_timeout_invalid");
  return {action, options, timeoutMs};
}

function gatewayUrl(options) {
  const raw = options.get("--gateway-url") || execFileSync("gcloud", ["run", "services", "describe", GATEWAY_SERVICE,
    "--region", REGION, "--project", PROJECT, "--format=value(status.url)"], {encoding: "utf8"}).trim();
  const url = new URL(raw);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".run.app") || url.username || url.password || url.search || url.hash) {
    throw Error("validation_gateway_url_invalid");
  }
  return url;
}

function validationSessionId(operationId) {
  const match = VALIDATION_OPERATION.exec(operationId);
  if (!match) throw Error("validation_operation_invalid");
  return `validation-${match[1]}`;
}

function routeHost(gateway, _operationId) {
  // Cloud Run only routes its exact service hostname. A synthetic subdomain
  // under *.a.run.app is rejected at the platform edge before the proxy can
  // forward it, so validation must use a dedicated gateway service/hostname.
  return gateway.hostname;
}

function operationRef(db, workspaceId, operationId) {
  return db.collection("vmMigrationOperations_v2").doc(workspaceId).collection("operations").doc(operationId);
}

async function readContext(db, input) {
  const operation = await operationRef(db, input.workspaceId, input.operationId).get();
  const record = operation.data();
  if (!operation.exists || record?.ownerUid !== input.ownerUid) throw Error("vm_migration_operation_not_found");
  const validation = record.validation;
  if (!validation?.operationId || !VALIDATION_OPERATION.test(validation.operationId)) throw Error("vm_migration_validation_cleanup_missing");
  const sessionId = validationSessionId(validation.operationId);
  const [runtime, session, credentials] = await Promise.all([
    db.collection(VALIDATION_COLLECTION).doc(input.workspaceId).get(),
    db.collection(VALIDATION_COLLECTION).doc(input.workspaceId).collection("sessions").doc(sessionId).get(),
    db.collection("vmMigrationValidationCredentials_v2").doc(sessionId).get(),
  ]);
  return {record, validation, sessionId, runtime, session, credentials};
}

function validationDescriptor(input, validation, destination) {
  return createRuntimeDescriptor({backend: "compute-engine", workspaceId: input.workspaceId, ownerUid: input.ownerUid,
    zone: destination.zone, region: destination.region, generation: destination.generation,
    dataDiskName: validation.cloneDiskName, instanceName: validation.instanceName});
}

async function writeRoute(db, route) {
  const ref = db.collection("vmGatewayRoutes_v2").doc(route.host);
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.exists) {
      const saved = current.data() || {};
      const same = ["validationOnly", "workspaceId", "ownerUid", "operationId", "validationOperationId", "sessionId", "generation", "deadlineMs", "address"]
        .every(key => saved[key] === route[key]);
      if (!same) throw Error("validation_route_identity_mismatch");
      return;
    }
    tx.create(ref, route);
  });
}

async function deleteRoute(db, route) {
  const ref = db.collection("vmGatewayRoutes_v2").doc(route.host);
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists) return;
    const saved = current.data() || {};
    const same = ["validationOnly", "workspaceId", "ownerUid", "operationId", "validationOperationId", "sessionId", "generation", "deadlineMs", "address"]
      .every(key => saved[key] === route[key]);
    if (!same) throw Error("validation_route_identity_mismatch");
    tx.delete(ref);
  });
}

async function gatewayRequest(gateway, host, path, headers, options = {}) {
  return fetch(new URL(path, gateway), {method: options.method || "GET", headers: {host, ...headers},
    signal: AbortSignal.timeout(options.timeoutMs || 15000), redirect: "error"});
}

async function waitForHealth(gateway, host, shutdownToken, expected, deadlineMs, timeoutMs) {
  const until = Math.min(Date.now() + timeoutMs, deadlineMs - 1000);
  let lastStatus = null;
  while (Date.now() < until) {
    try {
      const response = await gatewayRequest(gateway, host, "/runner/health", {"x-shutdown-token": shutdownToken}, {timeoutMs: 10000});
      lastStatus = response.status;
      if (response.ok) {
        const body = await response.json();
        if (body?.workspaceId === expected.workspaceId && body?.sessionId === expected.sessionId &&
            body?.agentRuntime?.ready === true) return {status: response.status, agentReady: true};
      } else await response.body?.cancel();
    } catch {
      // Boot failures are intentionally observed through the bounded deadline;
      // the cleanup path remains responsible for the Compute resources.
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(1, until - Date.now()))));
  }
  const error = Error("validation_health_timeout");
  error.lastStatus = lastStatus;
  throw error;
}

async function controlCall(credentials, payload, timeoutMs = 15000) {
  const response = await fetch(CONTROL_URL, {method: "POST", redirect: "error", headers: {
    "content-type": "application/json", authorization: `Bearer ${credentials.controlToken}`,
  }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs)});
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) {
    const error = Error(result.error || "vm_control_unavailable");
    error.code = result.error || "vm_control_unavailable";
    throw error;
  }
  return result;
}

async function releaseLease(db, context, input) {
  const runtime = context.runtime.data() || {};
  const credentials = context.credentials.data() || {};
  if (!context.runtime.exists || !context.credentials.exists || !runtime.bootId || runtime.state === "released") return false;
  try {
    await controlCall(credentials, {action: "lease.release", workspaceId: input.workspaceId, sessionId: context.sessionId,
      generation: runtime.generation, bootId: runtime.bootId});
    return true;
  } catch (error) {
    if (["vm_session_unavailable", "vm_writer_authority_lost", "vm_validation_authority_lost", "not_found"].includes(error.code)) return false;
    throw error;
  }
}

async function deleteValidationRecords(db, input, context) {
  const workspaceRef = db.collection(VALIDATION_COLLECTION).doc(input.workspaceId);
  const sessionRef = workspaceRef.collection("sessions").doc(context.sessionId);
  const credentialsRef = db.collection("vmMigrationValidationCredentials_v2").doc(context.sessionId);
  await db.runTransaction(async tx => {
    const [workspace, session, credentials] = await Promise.all([tx.get(workspaceRef), tx.get(sessionRef), tx.get(credentialsRef)]);
    const identity = {ownerUid: input.ownerUid, generation: context.record.importDestination.generation,
      migrationOperationId: input.operationId};
    if (workspace.exists && Object.entries(identity).some(([key, value]) => workspace.data()?.[key] !== value)) throw Error("validation_runtime_identity_mismatch");
    if (session.exists && Object.entries(identity).some(([key, value]) => session.data()?.[key] !== value)) throw Error("validation_runtime_identity_mismatch");
    if (credentials.exists && (credentials.data()?.ownerUid !== input.ownerUid || credentials.data()?.generation !== identity.generation)) {
      throw Error("validation_credentials_identity_mismatch");
    }
    if (workspace.exists) tx.delete(workspaceRef);
    if (session.exists) tx.delete(sessionRef);
    if (credentials.exists) tx.delete(credentialsRef);
  });
}

async function cleanup({db, compute, coordinator, input, gateway, context}) {
  const {record, validation} = context;
  const destination = record.importDestination;
  const descriptor = validationDescriptor(input, validation, destination);
  const host = routeHost(gateway, validation.operationId);
  const existingRoute = await db.collection("vmGatewayRoutes_v2").doc(host).get();
  let route = existingRoute.exists ? {host, ...existingRoute.data()} : null;
  const inspected = await compute.inspect(descriptor);
  if (inspected.instance?.privateAddress) {
    const expectedRoute = {host, validationOnly: true, enabled: true,
      workspaceId: input.workspaceId, ownerUid: input.ownerUid, operationId: input.operationId,
      validationOperationId: validation.operationId,
      sessionId: context.sessionId, generation: destination.generation, deadlineMs: validation.deadlineMs,
      address: inspected.instance.privateAddress};
    if (route && ["validationOnly", "workspaceId", "ownerUid", "operationId", "validationOperationId", "sessionId", "generation", "deadlineMs"]
        .some(key => route[key] !== expectedRoute[key])) throw Error("validation_route_identity_mismatch");
    route = {...expectedRoute, ...(route || {})};
    await writeRoute(db, route);
    const credentials = context.credentials.data() || {};
    if (credentials?.shutdownToken) {
      try { await gatewayRequest(gateway, route.host, "/shutdown", {"x-shutdown-token": credentials.shutdownToken}, {method: "POST", timeoutMs: 30000}); } catch {}
    }
  }
  await releaseLease(db, context, input);
  const result = await coordinator.cleanupValidationBoot(input);
  if (route) await deleteRoute(db, route);
  await deleteValidationRecords(db, input, context);
  return {instanceDeleted: result.validationCleanedAtMs !== null, diskDeleted: result.validationCleanedAtMs !== null};
}

async function main() {
  const {action, options, timeoutMs} = parseArgs(process.argv.slice(2));
  const app = admin.initializeApp({projectId: PROJECT}, "vm-migration-validation-boot");
  const db = app.firestore();
  const compute = createComputeEngineService({projectId: PROJECT});
  const coordinator = createVmMigrationCoordinator({db, inspectDestinationDisk: compute.inspectMigrationDisk,
    ensureValidationClone: compute.ensureMigrationValidationClone, startValidationVm: compute.startMigrationValidationVm,
    deleteValidationResources: compute.deleteMigrationValidationResources,
    defaultBucket: STORAGE_BUCKET,
    authorize: async (_, requested) => ["reserve-validation-boot", "prepare-validation-clone", "start-validation-boot", "cleanup-validation-boot"].includes(requested)});
  const input = {workspaceId: options.get("--workspace"), ownerUid: options.get("--owner"), operationId: options.get("--operation")};
  let gateway;
  let context;
  let passed = false;
  let health;
  let primaryError = null;
  try {
    gateway = gatewayUrl(options);
    if (action === "run") {
      const runnerImage = options.get("--runner-image");
      await coordinator.reserveValidationBoot({...input, runnerImage});
      await coordinator.prepareValidationClone(input);
      await coordinator.startValidationBoot(input);
      context = await readContext(db, input);
      const destination = context.record.importDestination;
      const descriptor = validationDescriptor(input, context.validation, destination);
      const inspected = await compute.inspect(descriptor);
      if (!inspected.instance?.privateAddress) throw Error("validation_instance_private_address_missing");
      const route = {host: routeHost(gateway, context.validation.operationId), validationOnly: true, enabled: true,
        workspaceId: input.workspaceId, ownerUid: input.ownerUid, operationId: input.operationId,
        validationOperationId: context.validation.operationId,
        sessionId: context.sessionId, generation: destination.generation, deadlineMs: context.validation.deadlineMs,
        address: inspected.instance.privateAddress};
      await writeRoute(db, route);
      health = await waitForHealth(gateway, route.host, context.credentials.data()?.shutdownToken,
        {workspaceId: input.workspaceId, sessionId: context.sessionId}, context.validation.deadlineMs, timeoutMs);
      passed = true;
    } else {
      context = await readContext(db, input);
    }
  } catch (error) {
    primaryError = error;
    try { context ||= await readContext(db, input); } catch {}
  }
  if (context?.validation?.cloneDiskName && context.validation.cleanedAtMs === undefined) {
    try {
      const cleaned = await cleanup({db, compute, coordinator, input, gateway, context});
      if (passed) console.log(JSON.stringify({status: "passed", workspaceId: input.workspaceId, operationId: input.operationId,
        sessionId: context.sessionId, instanceId: context.validation.instanceId, health, cleanup: cleaned}));
      else if (action === "cleanup") console.log(JSON.stringify({status: "cleaned", workspaceId: input.workspaceId,
        operationId: input.operationId, ...cleaned}));
    } catch (error) {
      if (!primaryError) primaryError = error;
    }
  }
  await app.delete();
  if (primaryError) {
    throw primaryError;
  }
}

main().catch(error => {
  const raw = error?.publicMessage || error?.code || error?.message || "validation_boot_failed";
  const reason = SAFE_REASONS.test(raw) ? raw : "validation_boot_failed";
  console.error(JSON.stringify({status: "blocked", reason, readyForCutover: false}));
  process.exitCode = 1;
});

