"use strict";

const {GoogleAuth} = require("google-auth-library");
const {COMPUTE_ENGINE_BACKEND, normalizeRuntimeDescriptor} = require("./runtimeProvider.helpers");
const {normalizeComputeEngineLabelValue} = require("./computeEngineLabels.helpers");

const COMPUTE_API = "https://compute.googleapis.com/compute/v1";
const DEFAULT_MACHINE_TYPE = "e2-standard-2";
const DEFAULT_DATA_DISK_TYPE = "pd-balanced";
const DEFAULT_DATA_DISK_SIZE_GB = 64;
const DEFAULT_ZONE = "us-central1-a";

function computeError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function createComputeEngineService(dependencies = {}) {
  const auth = dependencies.auth || new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]});
  const projectId = String(dependencies.projectId || process.env.GCLOUD_PROJECT || "pi-agents-cloud").trim();
  const requestImpl = dependencies.request || ((options) => request({...options, auth}));
  const now = dependencies.now || (() => new Date().toISOString());
  const machineType = dependencies.machineType || DEFAULT_MACHINE_TYPE;
  const dataDiskType = dependencies.dataDiskType || DEFAULT_DATA_DISK_TYPE;
  const dataDiskSizeGb = Number(dependencies.dataDiskSizeGb || DEFAULT_DATA_DISK_SIZE_GB);
  const zone = dependencies.zone || DEFAULT_ZONE;
  const runnerServiceAccount = String(dependencies.runnerServiceAccount || "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com").trim();
  const markSessionStopped = dependencies.markSessionStopped;
  const markMachineConfigurationApplied = dependencies.markMachineConfigurationApplied;

  return {
    ensureDataDisk: (descriptor, options) => ensureDataDisk(descriptor, options),
    ensureInstance: (descriptor, options) => ensureInstance(descriptor, options),
    inspect: (descriptor) => inspect(descriptor),
    pause: (descriptor, options) => pause(descriptor, options),
    start: (descriptor, options) => start(descriptor, options),
    replace: (descriptor, options) => replace(descriptor, options),
    deleteOwnedInstance: (descriptor, options) => deleteOwnedInstance(descriptor, options),
    provisionSessionService: (workspace, sessionRef, session, options) => provisionSessionService(workspace, sessionRef, session, options),
    patchSessionService: (sessionRef, session, options) => patchSessionService(sessionRef, session, options),
    deleteSessionService: (sessionRef, session, options) => deleteSessionService(sessionRef, session, options),
  };

  async function provisionSessionService(workspace, sessionRef, session, options = {}) {
    const descriptor = descriptorFor(session.runtimeProvider || session.runtimeProviderDescriptor);
    try {
      const result = await start(descriptor, {
        ...options,
        sizeGb: session.runtimeDataDiskSizeGb || options.sizeGb,
        runnerImage: session.image,
        operationId: session.provisioningOperationId || descriptor.generation,
        env: {
          MAPACHE_AGENT_UI_VERSION: session.agentUiVersion || "",
          MAPACHE_RUNTIME_KIND: session.runtimeKind || "main",
          SESSION_ID: sessionRef.id,
          SESSION_NAME: session.name || "Terminal session",
          SESSION_BROWSER_TOKEN_SECRET: session.browserAccessTokenSecret || "",
          ...(options.env || {}),
        },
      });
      const update = {
        status: "running",
        runtimeProviderState: "running",
        runtimeProviderOperationId: session.provisioningOperationId || null,
        serviceUrl: descriptor.gateway?.baseUrl || null,
        runtimeInstanceName: descriptor.instanceName,
        runtimeDataDiskName: descriptor.dataDiskName,
        runtimeDataDiskGeneration: descriptor.generation,
        lastError: null,
        updatedAt: firestoreTimestamp(dependencies.admin),
      };
      await sessionRef.update(update);
      if (typeof markMachineConfigurationApplied === "function" && session.machineConfigDesiredVersion) {
        await markMachineConfigurationApplied(descriptor.workspaceId, session.machineConfigDesiredVersion);
      }
      return {...session, ...update, runtimeProvider: descriptor};
    } catch (error) {
      await sessionRef.update({
        status: "provision_failed",
        runtimeProviderState: "error",
        lastError: error.code || "runtime_provider_failed",
        updatedAt: firestoreTimestamp(dependencies.admin),
      });
      throw error;
    }
  }

  async function patchSessionService(sessionRef, session, options = {}) {
    const descriptor = descriptorFor(session.runtimeProvider || session.runtimeProviderDescriptor);
    if (options.restart || options.start) {
      return provisionSessionService(null, sessionRef, session, options);
    }
    return inspect(descriptor);
  }

  async function deleteSessionService(sessionRef, session, options = {}) {
    const descriptor = descriptorFor(session.runtimeProvider || session.runtimeProviderDescriptor);
    const result = await pause(descriptor, options);
    if (typeof markSessionStopped === "function") await markSessionStopped(sessionRef, session, options.reason || "service_deleted");
    return {serviceAbsent: result.instanceDeleted === true, dataDiskRetained: true};
  }

  async function start(rawDescriptor, options = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    const disk = await ensureDataDisk(descriptor, options);
    const instance = await ensureInstance(descriptor, {...options, disk});
    return {backend: COMPUTE_ENGINE_BACKEND, descriptor, disk, instance, state: "running", observedAt: now()};
  }

  async function replace(rawDescriptor, options = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    await pause(descriptor, options);
    const nextDescriptor = {...descriptor, generation: descriptor.generation + 1, instanceName: null};
    return start(nextDescriptor, options);
  }

  async function pause(rawDescriptor, options = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    const current = await getInstance(descriptor).catch((error) => {
      if (error.code === "compute_not_found") return null;
      throw error;
    });
    if (!current) return {state: "stopped", instanceDeleted: true, dataDiskRetained: true};
    assertOwnership(current, descriptor);
    await deleteResource(instanceUrl(descriptor), options, descriptor);
    return {state: "stopped", instanceDeleted: true, dataDiskRetained: true, operation: current.operation || null};
  }

  async function deleteOwnedInstance(rawDescriptor, options = {}) {
    return pause(rawDescriptor, options);
  }

  async function inspect(rawDescriptor) {
    const descriptor = descriptorFor(rawDescriptor);
    const [disk, instance] = await Promise.all([
      getDisk(descriptor).catch((error) => error.code === "compute_not_found" ? null : Promise.reject(error)),
      getInstance(descriptor).catch((error) => error.code === "compute_not_found" ? null : Promise.reject(error)),
    ]);
    if (instance) assertOwnership(instance, descriptor);
    if (disk) assertOwnership(disk, descriptor);
    return {
      descriptor,
      disk: disk ? {name: disk.name, sizeGb: Number(disk.sizeGb), status: disk.status, labels: disk.labels || {}} : null,
      instance: instance ? {name: instance.name, status: instance.status, labels: instance.labels || {}, selfLink: instance.selfLink} : null,
      state: instance?.status === "RUNNING" ? "running" : "stopped",
      observedAt: new Date().toISOString(),
    };
  }

  async function ensureDataDisk(rawDescriptor, options = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    const existing = await getDisk(descriptor).catch((error) => {
      if (error.code === "compute_not_found") return null;
      throw error;
    });
    if (existing) {
      assertOwnership(existing, descriptor);
      if (existing.status !== "READY") throw computeError("runtime_data_disk_unusable", `Data disk is ${existing.status}`);
      if (options.expectedSizeGb && Number(existing.sizeGb) < Number(options.expectedSizeGb)) {
        throw computeError("runtime_data_disk_resize_required", "Data disk is smaller than the requested capacity");
      }
      return existing;
    }
    const sizeGb = Number(options.sizeGb || dataDiskSizeGb);
    if (!Number.isSafeInteger(sizeGb) || sizeGb < 10 || sizeGb > 4096) {
      throw computeError("runtime_data_disk_size_invalid", "Data disk size is outside the supported range");
    }
    const response = await requestImpl({
      url: `${zoneUrl(descriptor)}/disks`,
      method: "POST",
      params: {requestId: operationId(options.operationId || descriptor.workspaceId)},
      data: {
        name: descriptor.dataDiskName,
        sizeGb,
        type: `${zoneUrl(descriptor)}/diskTypes/${dataDiskType}`,
        labels: ownershipLabels(descriptor, options),
      },
    });
    await waitForOperation(response.data, descriptor, options);
    const created = await getDisk(descriptor);
    assertOwnership(created, descriptor);
    created._mapacheCreated = true;
    return created;
  }

  async function ensureInstance(rawDescriptor, options = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    const existing = await getInstance(descriptor).catch((error) => {
      if (error.code === "compute_not_found") return null;
      throw error;
    });
    if (existing) {
      assertOwnership(existing, descriptor);
      if (existing.status === "TERMINATED") {
        const response = await requestImpl({url: `${instanceUrl(descriptor)}/start`, method: "POST"});
        await waitForOperation(response.data, descriptor, options);
        return getInstance(descriptor);
      }
      if (existing.status !== "RUNNING" && existing.status !== "PROVISIONING" && existing.status !== "STAGING") {
        throw computeError("runtime_instance_unusable", `Instance is ${existing.status}`);
      }
      return existing;
    }
    const disk = options.disk || await ensureDataDisk(descriptor, options);
    const response = await requestImpl({
      url: `${zoneUrl(descriptor)}/instances`,
      method: "POST",
      params: {requestId: operationId(options.operationId || descriptor.workspaceId)},
      data: instanceBody(descriptor, disk, {...options, allowNewDisk: disk._mapacheCreated === true}),
    });
    await waitForOperation(response.data, descriptor, options);
    const created = await getInstance(descriptor);
    assertOwnership(created, descriptor);
    return created;
  }

  async function getDisk(descriptor) {
    return getResource(`${zoneUrl(descriptor)}/disks/${encodeURIComponent(descriptor.dataDiskName)}`);
  }

  async function getInstance(descriptor) {
    return getResource(instanceUrl(descriptor));
  }

  async function getResource(url) {
    try {
      const response = await requestImpl({url, method: "GET"});
      return response.data;
    } catch (error) {
      if (error?.response?.status === 404 || error?.code === 404) throw computeError("compute_not_found", "Compute resource was not found");
      throw error;
    }
  }

  async function deleteResource(url, options = {}, descriptor = null) {
    const response = await requestImpl({url, method: "DELETE", params: {requestId: operationId(options.operationId || "delete")}});
    await waitForOperation(response.data, descriptor, options);
  }

  async function waitForOperation(operation, descriptor, options = {}) {
    if (!operation?.name || operation.status === "DONE") {
      if (operation?.error?.errors?.length) throw computeError("compute_operation_failed", "Compute operation failed", {operation});
      return operation || null;
    }
    const poll = options.pollOperation || (async (name) => {
      const response = await requestImpl({url: operationUrl(operation, descriptor), method: "GET"});
      return response.data;
    });
    const deadline = Date.now() + Number(options.timeoutMs || 120000);
    let current = operation;
    while (current?.status !== "DONE") {
      if (Date.now() > deadline) throw computeError("compute_operation_timeout", "Compute operation did not complete before the deadline");
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
      current = await poll(operation.name);
    }
    if (current.error?.errors?.length) throw computeError("compute_operation_failed", "Compute operation failed", {operation: current});
    return current;
  }

  function descriptorFor(raw) {
    return normalizeRuntimeDescriptor(raw, {workspaceId: raw?.workspaceId, ownerUid: raw?.ownerUid});
  }

  function zoneUrl(descriptor) {
    return `${COMPUTE_API}/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(descriptor.zone || zone)}`;
  }

  function instanceUrl(descriptor) {
    return `${zoneUrl(descriptor)}/instances/${encodeURIComponent(descriptor.instanceName)}`;
  }

  function operationUrl(operation, descriptor) {
    const operationName = encodeURIComponent(operation.name.split("/").pop());
    if (operation.zone || descriptor?.zone) {
      const operationZone = String(operation.zone || descriptor.zone || zone).split("/").pop();
      return `${COMPUTE_API}/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(operationZone)}/operations/${operationName}`;
    }
    return `${COMPUTE_API}/projects/${encodeURIComponent(projectId)}/global/operations/${operationName}`;
  }

  function instanceBody(descriptor, disk, options) {
    const labels = ownershipLabels(descriptor, options);
    return {
      name: descriptor.instanceName,
      machineType: `${zoneUrl(descriptor)}/machineTypes/${options.machineType || machineType}`,
      labels,
      disks: [
        {boot: true, autoDelete: true, type: "PERSISTENT", initializeParams: {sourceImage: options.bootImage || "projects/cos-cloud/global/images/family/cos-stable"}},
        {boot: false, autoDelete: false, type: "PERSISTENT", mode: "READ_WRITE", source: disk.selfLink || `${zoneUrl(descriptor)}/disks/${descriptor.dataDiskName}`},
      ],
      networkInterfaces: [{subnetwork: options.subnetwork || `regions/${descriptor.region}/subnetworks/default`}],
      serviceAccounts: [{email: runnerServiceAccount, scopes: ["https://www.googleapis.com/auth/logging.write", "https://www.googleapis.com/auth/monitoring.write", "https://www.googleapis.com/auth/devstorage.read_only"]}],
      metadata: {items: [{key: "startup-script", value: startupScript(descriptor, options)}]},
    };
  }

  function startupScript(descriptor, options) {
    const image = String(options.runnerImage || "").trim();
    if (!image) throw computeError("runtime_runner_image_missing", "VM startup requires a pinned runner image");
    return [
      "#!/bin/bash",
      "set -euo pipefail",
      `DATA_DEVICE=/dev/disk/by-id/google-${descriptor.dataDiskName}`,
      "test -b \"$DATA_DEVICE\"",
      "mkdir -p /var/lib/mapache/workspace",
      "if ! blkid \"$DATA_DEVICE\" >/dev/null 2>&1; then",
      `  test \"${options.allowNewDisk === true ? "true" : "false"}\" = true`,
      `  mkfs.ext4 -L ${shellQuote(`mapache-${descriptor.workspaceId}`)} \"$DATA_DEVICE\"`,
      "fi",
      "mountpoint -q /var/lib/mapache/workspace || mount -o noatime \"$DATA_DEVICE\" /var/lib/mapache/workspace",
      "if [ -e /var/lib/mapache/workspace/.mapache-vm-disk.json ]; then",
      "  grep -q \"\\\"workspaceId\\\"[[:space:]]*:[[:space:]]*\\\"${WORKSPACE_ID}\\\"\" /var/lib/mapache/workspace/.mapache-vm-disk.json",
      "  grep -q \"\\\"ownerUid\\\"[[:space:]]*:[[:space:]]*\\\"${OWNER_UID}\\\"\" /var/lib/mapache/workspace/.mapache-vm-disk.json",
      "else",
      "  if find /var/lib/mapache/workspace -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit | grep -q .; then exit 42; fi",
      `  printf '%s\\n' ${shellQuote(JSON.stringify({version: 1, kind: "retained-disk", workspaceId: descriptor.workspaceId, ownerUid: descriptor.ownerUid, generation: descriptor.generation, operationId: options.operationId || null}))} > /var/lib/mapache/workspace/.mapache-vm-disk.json`,
      "fi",
      "# Docker is invoked by the startup script; deprecated container declarations are not used.",
      `docker pull ${shellQuote(image)}`,
      `docker run --rm --name mapache-runner --privileged=false --shm-size=${shellQuote(options.shmSize || "2g")} ${runtimeMountArgs()} ${runtimeEnvArgs(descriptor, options)} ${shellQuote(image)}`,
    ].join("\n");
  }

  function runtimeEnvArgs(descriptor, options) {
    const env = {
      RUNTIME_PROVIDER: COMPUTE_ENGINE_BACKEND,
      MAPACHE_RETAINED_DISK_ROOT: "/var/lib/mapache/workspace",
      MAPACHE_DATA_DISK_NAME: descriptor.dataDiskName,
      MAPACHE_ALLOW_FORMAT_NEW_DISK: options.allowNewDisk === true ? "true" : "false",
      MAPACHE_RUNTIME_PROVIDER: COMPUTE_ENGINE_BACKEND,
      MAPACHE_AGENT_RUNTIME_GENERATION: String(descriptor.generation),
      WORKSPACE_ID: descriptor.workspaceId,
      OWNER_UID: descriptor.ownerUid,
      WORKSPACE_STORAGE_MODE: "retained-disk",
      ...(options.env || {}),
    };
    return Object.entries(env).map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`).join(" ");
  }

  function runtimeMountArgs() {
    return [
      "-v /var/lib/mapache/workspace:/var/lib/mapache/workspace",
      "-v /var/lib/mapache/workspace/credentials:/var/lib/mapache/credentials:ro",
    ].join(" ");
  }

  function ownershipLabels(descriptor, options = {}) {
    return {
      "mapache-owner-uid": normalizeComputeEngineLabelValue(descriptor.ownerUid),
      "mapache-workspace-id": normalizeComputeEngineLabelValue(descriptor.workspaceId),
      "mapache-operation-id": normalizeComputeEngineLabelValue(options.operationId || descriptor.generation),
      "mapache-runtime-provider": COMPUTE_ENGINE_BACKEND,
    };
  }

  function assertOwnership(resource, descriptor) {
    const labels = resource?.labels || {};
    if (labels["mapache-owner-uid"] !== normalizeComputeEngineLabelValue(descriptor.ownerUid) ||
        labels["mapache-workspace-id"] !== normalizeComputeEngineLabelValue(descriptor.workspaceId) ||
        labels["mapache-runtime-provider"] !== COMPUTE_ENGINE_BACKEND) {
      throw computeError("runtime_resource_ownership_mismatch", "Compute resource ownership labels do not match the admitted workspace");
    }
  }

  function operationId(value) {
    return String(value || "operation").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "operation";
  }

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  function firestoreTimestamp(admin) {
    return admin?.firestore?.FieldValue?.serverTimestamp?.() || new Date().toISOString();
  }
}

async function request(options) {
  const auth = options.auth || new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]});
  const client = await auth.getClient();
  return client.request(options);
}

module.exports = {
  COMPUTE_API,
  DEFAULT_DATA_DISK_SIZE_GB,
  DEFAULT_DATA_DISK_TYPE,
  DEFAULT_MACHINE_TYPE,
  createComputeEngineService,
};
