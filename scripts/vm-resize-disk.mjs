#!/usr/bin/env node
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const PROJECT_ID = "pi-agents-cloud";
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export function parseArgs(argv = []) {
  const values = {project: PROJECT_ID, confirmResize: false};
  const seen = new Set();
  const aliases = new Map([
    ["project", "project"],
    ["workspace", "workspace"],
    ["owner", "owner"],
    ["generation", "generation"],
    ["size-gb", "sizeGb"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === "--confirm-resize") {
      if (seen.has("confirmResize")) throw new Error("duplicate --confirm-resize");
      seen.add("confirmResize");
      values.confirmResize = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const rawKey = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const key = aliases.get(rawKey);
    if (!key) throw new Error(`unsupported option: --${rawKey}`);
    if (seen.has(key)) throw new Error(`duplicate --${rawKey}`);
    seen.add(key);
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (value === undefined || String(value).startsWith("--")) {
      throw new Error(`missing or duplicate value for --${rawKey}`);
    }
    values[key] = String(value);
  }
  if (values.project !== PROJECT_ID) throw new Error(`project must be ${PROJECT_ID}`);
  for (const key of ["workspace", "owner"]) {
    if (!SAFE_ID.test(String(values[key] || ""))) throw new Error(`${key} is invalid`);
  }
  const generation = Number(values.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("generation is invalid");
  const sizeGb = Number(values.sizeGb);
  if (!Number.isSafeInteger(sizeGb) || sizeGb < 10 || sizeGb > 4096) throw new Error("size-gb is invalid");
  if (!values.confirmResize) throw new Error("--confirm-resize is required");
  return {...values, generation, sizeGb};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const admin = require("../functions/node_modules/firebase-admin");
  const {createComputeEngineService} = require("../functions/computeEngine.service.js");
  const {COMPUTE_ENGINE_BACKEND, normalizeRuntimeDescriptor} = require("../functions/runtimeProvider.helpers.js");
  const app = admin.initializeApp({projectId: PROJECT_ID}, "vm-resize-disk");
  try {
    const db = app.firestore();
    const runtimeRef = db.collection("vmRuntimes_v2").doc(options.workspace);
    const runtimeSnapshot = await runtimeRef.get();
    if (!runtimeSnapshot.exists) throw Object.assign(new Error("VM runtime does not exist"), {code: "vm_resize_runtime_missing"});
    const runtime = runtimeSnapshot.data() || {};
    if (runtime.ownerUid !== options.owner) throw Object.assign(new Error("VM runtime owner does not match"), {code: "vm_resize_owner_mismatch"});
    if (runtime.backend !== COMPUTE_ENGINE_BACKEND) throw Object.assign(new Error("VM runtime is not Compute Engine backed"), {code: "vm_resize_backend_unsupported"});
    if (runtime.generation !== options.generation) throw Object.assign(new Error("VM runtime generation does not match"), {code: "vm_resize_generation_mismatch"});
    if (runtime.state !== "stopped") throw Object.assign(new Error("VM runtime must be stopped before disk expansion"), {code: "vm_resize_runtime_not_stopped"});
    if (runtime.activeOperationId) throw Object.assign(new Error("VM runtime has an active operation"), {code: "vm_resize_operation_in_progress"});

    const fenceSnapshot = await db.collection("vmMigrationFences_v2").doc(options.workspace).get();
    if (fenceSnapshot.exists) throw Object.assign(new Error("VM migration fence is present"), {code: "vm_resize_migration_in_progress"});

    const descriptor = normalizeRuntimeDescriptor(runtime.runtimeProvider || runtime.runtimeProviderDescriptor,
      {workspaceId: options.workspace, ownerUid: options.owner});
    if (descriptor.backend !== COMPUTE_ENGINE_BACKEND || descriptor.generation !== options.generation) {
      throw Object.assign(new Error("VM runtime provider descriptor does not match"), {code: "vm_resize_descriptor_mismatch"});
    }
    const operationId = `resize-${options.workspace}-${options.generation}-${options.sizeGb}`;
    const compute = createComputeEngineService({projectId: PROJECT_ID});
    const result = await compute.resizeDataDisk(descriptor, {sizeGb: options.sizeGb, operationId});
    process.stdout.write(`${JSON.stringify({projectId: PROJECT_ID, workspaceId: options.workspace,
      generation: options.generation, operationId, result})}\n`);
  } finally {
    await app.delete();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const code = String(error?.code || "vm_resize_failed").slice(0, 120);
    const message = String(error?.message || code).slice(0, 120);
    process.stderr.write(`${JSON.stringify({error: code, message})}\n`);
    process.exitCode = 1;
  });
}
