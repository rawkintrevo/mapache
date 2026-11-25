"use strict";

const {GoogleAuth} = require("google-auth-library");
const {createHash} = require("node:crypto");
const {COMPUTE_ENGINE_BACKEND, normalizeRuntimeDescriptor} = require("./runtimeProvider.helpers");

const COMPUTE_API = "https://compute.googleapis.com/compute/v1";
const DEFAULT_MACHINE_TYPE = "e2-standard-2";
const DEFAULT_DATA_DISK_TYPE = "pd-balanced";
const DEFAULT_DATA_DISK_SIZE_GB = 64;
const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_FUNCTION_REGION = "us-central1";

function computeError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeComputeProviderError(error) {
  const status = Number(error?.response?.status || error?.status || error?.code);
  const entries = [
    ...(Array.isArray(error?.response?.data?.error?.errors) ? error.response.data.error.errors : []),
    ...(Array.isArray(error?.response?.data?.errors) ? error.response.data.errors : []),
    ...(Array.isArray(error?.error?.errors) ? error.error.errors : []),
    ...(Array.isArray(error?.errors) ? error.errors : []),
  ];
  const reason = entries.map(entry => `${entry?.reason || ""} ${entry?.message || ""}`).join(" ").toLowerCase();
  const message = String(error?.response?.data?.error?.message || error?.message || "").toLowerCase();
  if (status === 429 || /quota|ratelimit|rate limit|resource.?exhausted/.test(`${reason} ${message}`)) {
    return computeError("runtime_compute_quota_exhausted", "Compute quota is temporarily exhausted; lifecycle retry is required", {cause: error});
  }
  if (status === 409 || /resourceinuse|resource in use|already.?attached|attachment|disk.*users|operation.*conflict/.test(`${reason} ${message}`)) {
    return computeError("runtime_compute_attachment_conflict", "Compute resource attachment is busy; lifecycle retry is required", {cause: error});
  }
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
  const requestCompute = async (options) => {
    try {
      return await requestImpl(options);
    } catch (error) {
      throw normalizeComputeProviderError(error);
    }
  };

  return {
    ensureDataDisk: (descriptor, options) => ensureDataDisk(descriptor, options),
    ensureInstance: (descriptor, options) => ensureInstance(descriptor, options),
    inspect: (descriptor) => inspect(descriptor),
    listOwnedResources: (descriptor, options) => listOwnedResources(descriptor, options),
    resizeDataDisk: (descriptor, options) => resizeDataDisk(descriptor, options),
    inspectMigrationDisk: (descriptor, options) => inspectMigrationDisk(descriptor, options),
    inspectMigrationRuntime: (descriptor, options) => inspectMigrationRuntime(descriptor, options),
    deleteMigrationImportedDisk: (descriptor, options) => deleteMigrationImportedDisk(descriptor, options),
    ensureMigrationValidationClone: (descriptor, options) => ensureMigrationValidationClone(descriptor, options),
    startMigrationValidationVm: (descriptor, options) => startMigrationValidationVm(descriptor, options),
    deleteMigrationValidationResources: (descriptor, options) => deleteMigrationValidationResources(descriptor, options),
    pause: (descriptor, options) => pause(descriptor, options),
    start: (descriptor, options) => start(descriptor, options),
    replace: (descriptor, options) => replace(descriptor, options),
    deleteOwnedInstance: (descriptor, options) => deleteOwnedInstance(descriptor, options),
    deleteOwnedDisk: (descriptor, options) => deleteOwnedDisk(descriptor, options),
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
    return {serviceAbsent: result.instanceDeleted === true, dataDiskRetained: true, diskDetached: result.dataDiskRetained === true};
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
    if (current) {
      assertOwnership(current, descriptor);
      if (options.requireOperationMatch === true) assertOperationMatch(current, options.operationId);
      // Duplicate workers can both observe the instance before one deletes it.
      await deleteResource(instanceUrl(descriptor), options, descriptor).catch((error) => {
        if (error?.response?.status !== 404 && error?.code !== 404) throw error;
      });
    }
    // A completed DELETE is not permission to release writer admission while
    // the disk still reports an attachment, or if retained data is missing.
    const observed = await inspect(descriptor);
    if (observed.instance) throw computeError("runtime_instance_deletion_pending", "VM disappearance is not yet confirmed");
    if (!observed.disk) throw computeError("runtime_data_disk_missing", "Retained data disk is missing; automatic recovery is disabled");
    if (observed.disk.users.length) throw computeError("runtime_data_disk_attached", "Retained data disk is still attached; writer admission remains held");
    return {state: "stopped", instanceDeleted: true, dataDiskRetained: true, operation: current?.operation || null};
  }

  async function deleteOwnedInstance(rawDescriptor, options = {}) {
    return pause(rawDescriptor, options);
  }

  async function deleteOwnedDisk(rawDescriptor, {operationId: operationKey, timeoutMs = 240000} = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    if (typeof operationKey !== "string" || !operationKey.trim()) {
      throw computeError("runtime_data_disk_cleanup_operation_required", "Data disk cleanup requires an operation identity");
    }
    const disk = await getDisk(descriptor).catch((error) => error.code === "compute_not_found" ? null : Promise.reject(error));
    if (!disk) return {diskDeleted: true};
    assertOwnership(disk, descriptor);
    assertDiskCreation(disk, descriptor, operationKey);
    if (disk.status !== "READY" || !Array.isArray(disk.users) || disk.users.length) {
      throw computeError("runtime_data_disk_cleanup_unverified", "Recovery disk is not the exact detached operation disk");
    }
    await deleteResource(`${zoneUrl(descriptor)}/disks/${encodeURIComponent(descriptor.dataDiskName)}`, {
      operationId: operationKey, timeoutMs,
    }, descriptor);
    const remaining = await getDisk(descriptor).catch((error) => error.code === "compute_not_found" ? null : Promise.reject(error));
    if (remaining) throw computeError("runtime_data_disk_cleanup_pending", "Recovery disk deletion is not confirmed");
    return {diskDeleted: true};
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
      disk: disk ? {id: disk.id || null, name: disk.name, sizeGb: Number(disk.sizeGb), status: disk.status, labels: disk.labels || {}, users: disk.users || []} : null,
      instance: instance ? {name: instance.name, status: instance.status, labels: instance.labels || {}, selfLink: instance.selfLink,
        privateAddress: instance.networkInterfaces?.length === 1 && !instance.networkInterfaces[0].accessConfigs?.length &&
          instance.networkInterfaces[0].subnetwork?.endsWith("/subnetworks/mapache-vm-v2-us-central1") ? instance.networkInterfaces[0].networkIP : null} : null,
      state: instance?.status === "RUNNING" ? "running" : "stopped",
      observedAt: new Date().toISOString(),
    };
  }

  async function listOwnedResources(rawDescriptor, {maxResults = 100} = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    const limit = Number(maxResults);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw computeError("runtime_resource_inventory_limit_invalid", "Compute resource inventory limit is invalid");
    }
    const [instances, disks] = await Promise.all([
      listAggregatedResources("instances", limit),
      listAggregatedResources("disks", limit),
    ]);
    return {
      instances: instances.filter(resource => hasOwnershipLabels(resource, descriptor)),
      disks: disks.filter(resource => hasOwnershipLabels(resource, descriptor)),
    };
  }

  async function resizeDataDisk(rawDescriptor, {sizeGb, operationId: operationKey, timeoutMs = 240000} = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    if (typeof operationKey !== "string" || !operationKey.trim()) {
      throw computeError("runtime_data_disk_resize_operation_required", "Data disk resize requires an operation identity");
    }
    const requestedSizeGb = Number(sizeGb);
    if (!Number.isSafeInteger(requestedSizeGb) || requestedSizeGb < 10 || requestedSizeGb > 4096) {
      throw computeError("runtime_data_disk_resize_size_invalid", "Data disk resize is outside the supported range");
    }
    const disk = await getDisk(descriptor);
    assertOwnership(disk, descriptor);
    const currentSizeGb = Number(disk.sizeGb);
    if (!Number.isSafeInteger(currentSizeGb) || currentSizeGb < 10) {
      throw computeError("runtime_data_disk_resize_current_size_invalid", "Current data disk capacity is invalid");
    }
    if (requestedSizeGb < currentSizeGb) {
      throw computeError("runtime_data_disk_shrink_forbidden", "Data disk capacity can only be expanded");
    }
    if (disk.status !== "READY") {
      throw computeError("runtime_data_disk_resize_unusable", "Data disk is not ready for expansion");
    }
    if (Array.isArray(disk.users) && disk.users.length) {
      throw computeError("runtime_data_disk_resize_attached", "Data disk must be detached before expansion");
    }
    if (requestedSizeGb === currentSizeGb) {
      return {resized: false, diskName: disk.name, diskId: disk.id || null, sizeGb: currentSizeGb};
    }
    const response = await requestCompute({
      url: `${zoneUrl(descriptor)}/disks/${encodeURIComponent(descriptor.dataDiskName)}/resize`,
      method: "POST",
      params: {requestId: operationId(`resize:${descriptor.dataDiskName}:${operationKey}`)},
      data: {sizeGb: requestedSizeGb},
    });
    await waitForOperation(response.data, descriptor, {timeoutMs});
    const updated = await getDisk(descriptor);
    assertOwnership(updated, descriptor);
    if (Number(updated.sizeGb) < requestedSizeGb) {
      throw computeError("runtime_data_disk_resize_unconfirmed", "Expanded data disk capacity was not confirmed");
    }
    return {resized: true, diskName: updated.name, diskId: updated.id || null, sizeGb: Number(updated.sizeGb)};
  }

  async function listAggregatedResources(kind, limit) {
    const items = [];
    let pageToken = null;
    do {
      const response = await requestCompute({url: `${COMPUTE_API}/projects/${encodeURIComponent(projectId)}/aggregated/${kind}`,
        method: "GET", params: {maxResults: Math.min(limit - items.length, 500), ...(pageToken ? {pageToken} : {})}});
      const entries = response.data?.items && typeof response.data.items === "object" ? Object.values(response.data.items) : [];
      for (const entry of entries) {
        const resources = Array.isArray(entry?.[kind]) ? entry[kind] : [];
        items.push(...resources.slice(0, Math.max(0, limit - items.length)));
        if (items.length >= limit) break;
      }
      pageToken = items.length >= limit ? null : response.data?.nextPageToken || null;
    } while (pageToken);
    return items;
  }

  async function ensureDataDisk(rawDescriptor, options = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    const existing = await getDisk(descriptor).catch((error) => {
      if (error.code === "compute_not_found") return null;
      throw error;
    });
    if (existing) {
      assertOwnership(existing, descriptor);
      if (options.requireCreationMatch === true) assertDiskCreation(existing, descriptor, options.operationId);
      if (existing.status !== "READY") throw computeError("runtime_data_disk_unusable", `Data disk is ${existing.status}`);
      if (options.expectedSizeGb && Number(existing.sizeGb) < Number(options.expectedSizeGb)) {
        throw computeError("runtime_data_disk_resize_required", "Data disk is smaller than the requested capacity");
      }
      return existing;
    }
    if (options.allowCreateDisk !== true) {
      throw computeError("runtime_data_disk_missing", "Retained data disk is missing; only an explicitly admitted new workspace may create one");
    }
    const sizeGb = Number(options.sizeGb || dataDiskSizeGb);
    if (!Number.isSafeInteger(sizeGb) || sizeGb < 10 || sizeGb > 4096) {
      throw computeError("runtime_data_disk_size_invalid", "Data disk size is outside the supported range");
    }
    const response = await requestCompute({
      url: `${zoneUrl(descriptor)}/disks`,
      method: "POST",
      params: {requestId: operationId(`disk:${descriptor.dataDiskName}:${options.operationId || descriptor.generation}`)},
      data: {
        name: descriptor.dataDiskName,
        sizeGb,
        type: `${zoneUrl(descriptor)}/diskTypes/${dataDiskType}`,
        labels: {...ownershipLabels(descriptor, options), "mapache-created-generation": String(descriptor.generation)},
      },
    });
    await waitForOperation(response.data, descriptor, options);
    const created = await getDisk(descriptor);
    assertOwnership(created, descriptor);
    return created;
  }

  function assertDiskCreation(disk, descriptor, operationId) {
    if (disk.labels?.["mapache-created-generation"] !== String(descriptor.generation) ||
        disk.labels?.["mapache-operation-id"] !== identityLabel(String(operationId || descriptor.generation))) {
      throw computeError("runtime_data_disk_creation_conflict", "Existing disk belongs to another creation operation");
    }
  }

  function assertOperationMatch(instance, operationKey) {
    if (instance?.labels?.["mapache-operation-id"] !== identityLabel(String(operationKey || ""))) {
      throw computeError("runtime_instance_operation_mismatch", "Existing recovery VM belongs to another operation");
    }
  }

  async function inspectMigrationDisk(rawDescriptor, {operationId, maintenance} = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    if (typeof operationId !== "string" || !operationId) throw computeError("runtime_disk_operation_required");
    const disk = await getDisk(descriptor);
    assertOwnership(disk, descriptor);
    assertDiskCreation(disk, descriptor, operationId);
    if (disk.name !== descriptor.dataDiskName || typeof disk.id !== "string" || !/^[1-9][0-9]{0,19}$/.test(disk.id) ||
        disk.status !== "READY" || !disk.zone?.endsWith("/zones/" + descriptor.zone) ||
        (disk.users !== undefined && !Array.isArray(disk.users))) {
      throw computeError("runtime_migration_disk_unverified", "Migration disk identity is unverified");
    }
    const result = {diskId: disk.id, diskName: disk.name, zone: descriptor.zone,
      ...(disk.lastAttachTimestamp ? {lastAttachTimestamp: disk.lastAttachTimestamp} : {}),
      ...(disk.type ? {diskType: disk.type} : {})};
    if (!maintenance) {
      if (disk.users?.length) throw computeError("runtime_migration_disk_unverified", "Migration disk is still attached");
      return result;
    }

    const {instanceName, instanceId} = maintenance;
    const refuse = () => computeError("runtime_migration_maintenance_attachment_unverified");
    if (typeof instanceName !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(instanceName) ||
        typeof instanceId !== "string" || !/^[1-9][0-9]{0,19}$/.test(instanceId)) throw refuse();
    const base = zoneUrl(descriptor);
    const instanceUrl = base + "/instances/" + instanceName;
    const diskUrl = base + "/disks/" + descriptor.dataDiskName;
    const equivalent = (actual, expected) => actual === expected || actual === expected.replace("compute.googleapis.com", "www.googleapis.com");
    if (disk.users?.length !== 1 || !equivalent(disk.users[0], instanceUrl) ||
        !Number.isFinite(Date.parse(disk.lastAttachTimestamp))) throw refuse();
    const instance = await getResource(instanceUrl);
    const attachments = (instance.disks || []).filter(attachment => equivalent(attachment.source, diskUrl));
    if (instance.id !== instanceId || instance.name !== instanceName || instance.status !== "RUNNING" ||
        instance.networkInterfaces?.length !== 1 || instance.networkInterfaces[0].accessConfigs?.length ||
        instance.networkInterfaces[0].ipv6AccessConfigs?.length || attachments.length !== 1 ||
        attachments[0].deviceName !== descriptor.dataDiskName || attachments[0].boot !== false ||
        attachments[0].autoDelete !== false || attachments[0].mode !== "READ_ONLY") throw refuse();
    return {...result, instanceId, attachmentTimestamp: disk.lastAttachTimestamp};
  }

  async function inspectMigrationRuntime(rawDescriptor, {operationId, diskId} = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    if (typeof operationId !== "string" || !operationId || !/^[1-9][0-9]{0,19}$/.test(String(diskId || ""))) {
      throw computeError("runtime_migration_runtime_invalid", "Migration runtime identity is invalid");
    }
    const disk = await getDisk(descriptor);
    assertOwnership(disk, descriptor);
    assertDiskCreation(disk, descriptor, operationId);
    if (disk.name !== descriptor.dataDiskName || String(disk.id) !== String(diskId) ||
        disk.status !== "READY" || !Array.isArray(disk.users) || disk.users.length !== 1 ||
        !disk.zone?.endsWith("/zones/" + descriptor.zone)) {
      throw computeError("runtime_migration_runtime_unverified", "Migration runtime disk is not the admitted attached disk");
    }
    const instance = await getInstance(descriptor);
    assertOwnership(instance, descriptor);
    const base = zoneUrl(descriptor);
    const instanceUrl = `${base}/instances/${descriptor.instanceName}`;
    const diskUrl = `${base}/disks/${descriptor.dataDiskName}`;
    const equivalent = (actual, expected) => actual === expected || actual === expected.replace("compute.googleapis.com", "www.googleapis.com");
    const attachments = (instance.disks || []).filter(attachment => equivalent(attachment.source, diskUrl));
    const network = instance.networkInterfaces || [];
    if (disk.users[0] !== instanceUrl && disk.users[0] !== instanceUrl.replace("compute.googleapis.com", "www.googleapis.com")) {
      throw computeError("runtime_migration_runtime_unverified", "Migration runtime disk is attached to another instance");
    }
    if (instance.name !== descriptor.instanceName || instance.status !== "RUNNING" ||
        network.length !== 1 || network[0].accessConfigs?.length || network[0].ipv6AccessConfigs?.length ||
        attachments.length !== 1 || attachments[0].deviceName !== descriptor.dataDiskName ||
        attachments[0].boot !== false || attachments[0].autoDelete !== false || attachments[0].mode !== "READ_WRITE") {
      throw computeError("runtime_migration_runtime_unverified", "Migration runtime attachment is not verified");
    }
    return {diskId: String(disk.id), diskName: disk.name, zone: descriptor.zone, attached: true,
      instanceId: String(instance.id), instanceName: instance.name, instanceReady: true,
      attachmentTimestamp: disk.lastAttachTimestamp ?? null};
  }

  async function deleteMigrationImportedDisk(rawDescriptor, {operationId, diskId, timeoutMs = 240000} = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    if (typeof operationId !== "string" || !operationId || !/^[1-9][0-9]{0,19}$/.test(String(diskId || ""))) {
      throw computeError("runtime_migration_disk_cleanup_invalid", "Migration disk cleanup identity is invalid");
    }
    const disk = await getDisk(descriptor).catch(error => error.code === "compute_not_found" ? null : Promise.reject(error));
    if (!disk) return {diskDeleted: true, diskId: String(diskId)};
    assertOwnership(disk, descriptor);
    assertDiskCreation(disk, descriptor, operationId);
    if (disk.name !== descriptor.dataDiskName || String(disk.id) !== String(diskId) || disk.status !== "READY" ||
        !Array.isArray(disk.users) || disk.users.length) {
      throw computeError("runtime_migration_disk_cleanup_unverified", "Migration disk is not the detached admitted destination");
    }
    const diskUrl = `${zoneUrl(descriptor)}/disks/${descriptor.dataDiskName}`;
    await deleteResource(diskUrl, {operationId, timeoutMs}, descriptor).catch(error => {
      if (error?.response?.status !== 404 && error?.code !== 404) throw error;
    });
    const remaining = await getDisk(descriptor).catch(error => error.code === "compute_not_found" ? null : Promise.reject(error));
    if (remaining) throw computeError("runtime_migration_disk_cleanup_pending", "Migration disk deletion is not confirmed");
    return {diskDeleted: true, diskId: String(diskId)};
  }

  async function ensureMigrationValidationClone(rawDescriptor, {
    sourceOperationId, sourceDiskId, sourceLastAttachTimestamp, cloneDiskName, operationId, timeoutMs = 240000,
  } = {}) {
    const source = descriptorFor(rawDescriptor);
    if (typeof cloneDiskName !== "string" || !/^mapache-val-disk-[a-f0-9]{24}$/.test(cloneDiskName) ||
        cloneDiskName === source.dataDiskName || typeof operationId !== "string" || !operationId) {
      throw computeError("runtime_validation_clone_invalid");
    }
    const target = descriptorFor({...source, dataDiskName: cloneDiskName});
    const checkSource = async () => {
      const disk = await inspectMigrationDisk(source, {operationId: sourceOperationId});
      if (disk.diskId !== sourceDiskId || (disk.lastAttachTimestamp ?? null) !== sourceLastAttachTimestamp) {
        throw computeError("runtime_validation_source_disk_changed");
      }
      return disk;
    };
    const sourceDisk = await checkSource();
    let clone = await getDisk(target).catch(error => {
      if (error.code === "compute_not_found") return null;
      throw error;
    });
    const sourceUrl = zoneUrl(source) + "/disks/" + source.dataDiskName;
    if (!clone) {
      const response = await requestCompute({url: zoneUrl(target) + "/disks", method: "POST",
        params: {requestId: diskCloneRequestId(operationId, sourceDiskId)},
        data: {name: cloneDiskName, sourceDisk: sourceUrl, type: sourceDisk.diskType || zoneUrl(source) + "/diskTypes/" + dataDiskType,
          labels: {...ownershipLabels(target, {operationId}), "mapache-created-generation": String(target.generation),
            "mapache-validation-only": "true"}}});
      await waitForOperation(response.data, target, {timeoutMs});
      clone = await getDisk(target);
    }
    assertOwnership(clone, target);
    assertDiskCreation(clone, target, operationId);
    if (clone.name !== cloneDiskName || typeof clone.id !== "string" || !/^[1-9][0-9]{0,19}$/.test(clone.id) ||
        clone.id === sourceDiskId || clone.sourceDiskId !== sourceDiskId ||
        ![sourceUrl, sourceUrl.replace("compute.googleapis.com", "www.googleapis.com")].includes(clone.sourceDisk) ||
        clone.status !== "READY" || clone.labels?.["mapache-validation-only"] !== "true" ||
        clone.users !== undefined && (!Array.isArray(clone.users) || clone.users.length)) {
      throw computeError("runtime_validation_clone_unverified");
    }
    await checkSource();
    return {cloneDiskId: clone.id, cloneDiskName, sourceDiskId};
  }

  function diskCloneRequestId(validationOperationId, sourceDiskId) {
    return operationId("migration-validation-clone:" + validationOperationId + ":" + sourceDiskId);
  }

  async function startMigrationValidationVm(rawDescriptor, {operationId, cloneDiskId, sourceDiskId, runnerImage, sessionId, credentials} = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    const key = /^mapache-val-disk-([a-f0-9]{24})$/.exec(descriptor.dataDiskName)?.[1];
    if (projectId !== "pi-agents-cloud" || !key || descriptor.instanceName !== "mapache-val-vm-" + key ||
        operationId !== "validate-" + key || sessionId !== "validation-" + key ||
        typeof cloneDiskId !== "string" || !/^[1-9][0-9]{0,19}$/.test(cloneDiskId) || cloneDiskId === sourceDiskId ||
        typeof sourceDiskId !== "string" || !/^[1-9][0-9]{0,19}$/.test(sourceDiskId) ||
        !/^us-central1-docker\.pkg\.dev\/pi-agents-cloud\/pi-agents\/session-runner@sha256:[a-f0-9]{64}$/.test(runnerImage || "") ||
        !["controlToken", "browserToken", "shutdownToken"].every(name => /^[a-f0-9]{64}$/.test(credentials?.[name] || ""))) {
      throw computeError("runtime_validation_boot_invalid");
    }
    const checkClone = async () => {
      const disk = await ensureDataDisk(descriptor, {operationId, requireCreationMatch: true});
      if (disk.id !== cloneDiskId || disk.sourceDiskId !== sourceDiskId || disk.labels?.["mapache-validation-only"] !== "true") {
        throw computeError("runtime_validation_clone_unverified");
      }
      return disk;
    };
    const disk = await checkClone();
    const instance = await ensureInstance(descriptor, {operationId, disk, runnerImage, validationOnly: true, timeoutMs: 240000,
      subnetwork: "projects/pi-agents-cloud/regions/us-central1/subnetworks/mapache-vm-v2-us-central1", env: {
        GCLOUD_PROJECT: projectId, MAPACHE_AGENT_UI_VERSION: "pi-web-ui-v1", MAPACHE_PI_MODEL_CATALOG_REFRESH: "false",
        MAPACHE_VM_CONTROL_URL: "https://us-central1-pi-agents-cloud.cloudfunctions.net/vmMigrationValidationControl_v2",
        MAPACHE_VM_CONTROL_TOKEN: credentials.controlToken, SESSION_ID: sessionId,
        SESSION_BROWSER_TOKEN_SECRET: credentials.browserToken, SESSION_SHUTDOWN_TOKEN: credentials.shutdownToken,
        RUNNER_CAPABILITIES: JSON.stringify({terminal: true, preview: false, chrome: false, previewQa: false, functions: false}),
      }});
    const attached = await checkClone();
    const url = instanceUrl(descriptor);
    if (typeof instance.id !== "string" || !/^[1-9][0-9]{0,19}$/.test(instance.id) ||
        instance.labels?.["mapache-validation-only"] !== "true" ||
        instance.labels?.["mapache-operation-id"] !== identityLabel(operationId) ||
        instance.networkInterfaces?.length !== 1 || instance.networkInterfaces[0].accessConfigs?.length ||
        instance.networkInterfaces[0].ipv6AccessConfigs?.length ||
        !instance.networkInterfaces[0].subnetwork?.endsWith("/subnetworks/mapache-vm-v2-us-central1") ||
        attached.users?.length !== 1 || ![url, url.replace("compute.googleapis.com", "www.googleapis.com")].includes(attached.users[0])) {
      throw computeError("runtime_validation_instance_unverified");
    }
    return {instanceId: instance.id, instanceName: instance.name, cloneDiskId};
  }

  async function deleteMigrationValidationResources(rawDescriptor, {
    operationId, cloneDiskId, sourceDiskId, timeoutMs = 240000,
  } = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    const key = /^mapache-val-disk-([a-f0-9]{24})$/.exec(descriptor.dataDiskName)?.[1];
    if (projectId !== "pi-agents-cloud" || !key || descriptor.instanceName !== "mapache-val-vm-" + key ||
        operationId !== "validate-" + key || !/^[1-9][0-9]{0,19}$/.test(cloneDiskId || "") ||
        !/^[1-9][0-9]{0,19}$/.test(sourceDiskId || "") || cloneDiskId === sourceDiskId) {
      throw computeError("runtime_validation_cleanup_invalid");
    }
    const diskUrl = `${zoneUrl(descriptor)}/disks/${descriptor.dataDiskName}`;
    const instance = await getInstance(descriptor).catch(error => error.code === "compute_not_found" ? null : Promise.reject(error));
    const disk = await getDisk(descriptor).catch(error => error.code === "compute_not_found" ? null : Promise.reject(error));
    if (instance) {
      assertOwnership(instance, descriptor);
      assertInstanceDisk(instance, descriptor);
      if (!/^[1-9][0-9]{0,19}$/.test(String(instance.id || "")) || instance.labels?.["mapache-validation-only"] !== "true" ||
          instance.labels?.["mapache-operation-id"] !== identityLabel(operationId)) {
        throw computeError("runtime_validation_cleanup_unverified");
      }
      await deleteResource(instanceUrl(descriptor), {operationId, timeoutMs}, descriptor);
    }
    const currentDisk = await getDisk(descriptor).catch(error => error.code === "compute_not_found" ? null : Promise.reject(error));
    if (currentDisk) {
      assertOwnership(currentDisk, descriptor);
      assertDiskCreation(currentDisk, descriptor, operationId);
      if (currentDisk.id !== cloneDiskId || currentDisk.sourceDiskId !== sourceDiskId ||
          currentDisk.labels?.["mapache-validation-only"] !== "true" ||
          (currentDisk.users !== undefined && (!Array.isArray(currentDisk.users) || currentDisk.users.length))) {
        throw computeError("runtime_validation_cleanup_unverified");
      }
      await deleteResource(diskUrl, {operationId, timeoutMs}, descriptor);
    } else if (disk && disk.id !== cloneDiskId) {
      throw computeError("runtime_validation_cleanup_unverified");
    }
    const [remainingInstance, remainingDisk] = await Promise.all([
      getInstance(descriptor).catch(error => error.code === "compute_not_found" ? null : Promise.reject(error)),
      getDisk(descriptor).catch(error => error.code === "compute_not_found" ? null : Promise.reject(error)),
    ]);
    if (remainingInstance || remainingDisk) throw computeError("runtime_validation_cleanup_pending");
    return {instanceDeleted: true, diskDeleted: true, cloneDiskId, sourceDiskId};
  }

  async function ensureInstance(rawDescriptor, options = {}) {
    const descriptor = descriptorFor(rawDescriptor);
    const existing = await getInstance(descriptor).catch((error) => {
      if (error.code === "compute_not_found") return null;
      throw error;
    });
    if (existing) {
      assertOwnership(existing, descriptor);
      assertInstanceDisk(existing, descriptor);
      if (options.requireOperationMatch === true) assertOperationMatch(existing, options.operationId);
      if (existing.status === "TERMINATED") {
        throw computeError("runtime_generation_replacement_required", "A stopped VM requires a new generation and credentials; do not restart its expired boot");
      }
      if (existing.status !== "RUNNING" && existing.status !== "PROVISIONING" && existing.status !== "STAGING") {
        throw computeError("runtime_instance_unusable", `Instance is ${existing.status}`);
      }
      return existing;
    }
    const disk = options.disk || await ensureDataDisk(descriptor, options);
    if (disk.users?.length) throw computeError("runtime_data_disk_attached", "Retained disk still has a writer attachment; replacement must wait");
    const response = await requestCompute({
      url: `${zoneUrl(descriptor)}/instances`,
      method: "POST",
      params: {requestId: operationId(`instance:${descriptor.instanceName}:${options.operationId || descriptor.generation}`)},
      // Creation authority survives a worker restart, but cannot be borrowed
      // by a later generation, another operation, or an ordinary resume.
      data: instanceBody(descriptor, disk, {...options, allowNewDisk: (options.allowCreateDisk === true || options.allowInitializeDisk === true) &&
        disk.labels?.["mapache-created-generation"] === String(descriptor.generation) &&
        disk.labels?.["mapache-operation-id"] === identityLabel(String(options.operationId || descriptor.generation))}),
    });
    await waitForOperation(response.data, descriptor, options);
    const created = await getInstance(descriptor);
    assertOwnership(created, descriptor);
    assertInstanceDisk(created, descriptor);
    return created;
  }

  function assertInstanceDisk(instance, descriptor) {
    const expected = `${zoneUrl(descriptor)}/disks/${descriptor.dataDiskName}`;
    const sourceUrls = [expected, expected.replace("https://compute.googleapis.com/", "https://www.googleapis.com/")];
    const dataDisks = (instance.disks || []).filter((disk) => !disk.boot);
    if (dataDisks.length !== 1 || !sourceUrls.includes(dataDisks[0].source) ||
        dataDisks[0].autoDelete !== false || dataDisks[0].mode !== "READ_WRITE") {
      throw computeError("runtime_data_disk_attachment_mismatch", "VM attachment does not match the admitted retained disk");
    }
  }

  async function getDisk(descriptor) {
    return getResource(`${zoneUrl(descriptor)}/disks/${encodeURIComponent(descriptor.dataDiskName)}`);
  }

  async function getInstance(descriptor) {
    return getResource(instanceUrl(descriptor));
  }

  async function getResource(url) {
    try {
      const response = await requestCompute({url, method: "GET"});
      return response.data;
    } catch (error) {
      if (error?.response?.status === 404 || error?.code === 404) throw computeError("compute_not_found", "Compute resource was not found");
      throw error;
    }
  }

  async function deleteResource(url, options = {}, descriptor = null) {
    const response = await requestCompute({url, method: "DELETE", params: {requestId: operationId(`delete:${url}:${options.operationId || descriptor?.generation}`)}});
    await waitForOperation(response.data, descriptor, options);
  }

  async function waitForOperation(operation, descriptor, options = {}) {
    if (!operation?.name || operation.status === "DONE") {
      if (operation?.error?.errors?.length) throw computeOperationFailure(operation);
      return operation || null;
    }
    const poll = options.pollOperation || (async (name) => {
      const response = await requestCompute({url: operationUrl(operation, descriptor), method: "GET"});
      return response.data;
    });
    const deadline = Date.now() + Number(options.timeoutMs || 120000);
    let current = operation;
    while (current?.status !== "DONE") {
      if (Date.now() > deadline) throw computeError("compute_operation_timeout", "Compute operation did not complete before the deadline");
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
      current = await poll(operation.name);
    }
    if (current.error?.errors?.length) throw computeOperationFailure(current);
    return current;
  }

  function computeOperationFailure(operation) {
    const normalized = normalizeComputeProviderError({
      message: "Compute operation failed",
      response: {data: {error: {errors: operation.error.errors}}},
    });
    if (normalized !== undefined && normalized !== null && normalized.code !== undefined &&
        normalized.code !== "compute_operation_failed") {
      normalized.operation = operation;
      return normalized;
    }
    return computeError("compute_operation_failed", "Compute operation failed", {operation});
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
    const labels = {...ownershipLabels(descriptor, options), ...(options.validationOnly ? {"mapache-validation-only": "true"} : {})};
    return {
      name: descriptor.instanceName,
      machineType: `${zoneUrl(descriptor)}/machineTypes/${options.machineType || machineType}`,
      labels,
      disks: [
        {boot: true, autoDelete: true, type: "PERSISTENT", initializeParams: {sourceImage: options.bootImage || "projects/cos-cloud/global/images/family/cos-stable"}},
        {boot: false, autoDelete: false, deviceName: descriptor.dataDiskName, type: "PERSISTENT", mode: "READ_WRITE", source: disk.selfLink || `${zoneUrl(descriptor)}/disks/${descriptor.dataDiskName}`},
      ],
      networkInterfaces: [{subnetwork: options.subnetwork || `regions/${descriptor.region}/subnetworks/default`}],
      tags: {items: ["mapache-vm-v2"]},
      serviceAccounts: [{email: runnerServiceAccount, scopes: ["https://www.googleapis.com/auth/logging.write", "https://www.googleapis.com/auth/monitoring.write", "https://www.googleapis.com/auth/devstorage.read_only"]}],
      metadata: {items: [{key: "disable-legacy-endpoints", value: "TRUE"}, {key: "startup-script", value: startupScript(descriptor, options)}]},
    };
  }

  function startupScript(descriptor, options) {
    const image = String(options.runnerImage || "").trim();
    if (!image) throw computeError("runtime_runner_image_missing", "VM startup requires a pinned runner image");
    return [
      "#!/bin/bash",
      "set -euo pipefail",
      `WORKSPACE_ID=${shellQuote(descriptor.workspaceId)}`,
      `OWNER_UID=${shellQuote(descriptor.ownerUid)}`,
      `DATA_DEVICE=/dev/disk/by-id/google-${descriptor.dataDiskName}`,
      "test -b \"$DATA_DEVICE\"",
      "mkdir -p /var/lib/mapache/workspace",
      "BLKID_STATUS=0",
      "blkid -p \"$DATA_DEVICE\" >/dev/null 2>&1 || BLKID_STATUS=$?",
      "if [ \"$BLKID_STATUS\" != 0 ]; then",
      "  test \"$BLKID_STATUS\" = 2 # No signature; I/O/probe errors must not authorize formatting.",
      `  test \"${options.allowNewDisk === true ? "true" : "false"}\" = true`,
      "  mkfs.ext4 -L mapache-data \"$DATA_DEVICE\"",
      "fi",
      "mountpoint -q /var/lib/mapache/workspace || mount -t ext4 -o noatime \"$DATA_DEVICE\" /var/lib/mapache/workspace",
      "if [ -e /var/lib/mapache/workspace/.mapache-vm-disk.json ]; then",
      "  grep -q \"\\\"workspaceId\\\"[[:space:]]*:[[:space:]]*\\\"${WORKSPACE_ID}\\\"\" /var/lib/mapache/workspace/.mapache-vm-disk.json",
      "  grep -q \"\\\"ownerUid\\\"[[:space:]]*:[[:space:]]*\\\"${OWNER_UID}\\\"\" /var/lib/mapache/workspace/.mapache-vm-disk.json",
      "else",
      `  test \"${options.allowNewDisk === true ? "true" : "false"}\" = true`,
      "  if find /var/lib/mapache/workspace -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit | grep -q .; then exit 42; fi",
      `  printf '%s\\n' ${shellQuote(JSON.stringify({version: 1, kind: "retained-disk", workspaceId: descriptor.workspaceId, ownerUid: descriptor.ownerUid, generation: descriptor.generation, operationId: options.operationId || null}))} > /var/lib/mapache/workspace/.mapache-vm-disk.json`,
      "fi",
      "# Docker is invoked by the startup script; deprecated container declarations are not used.",
      "mkdir -p /var/lib/mapache/workspace/credentials",
      "# Container-Optimized OS has a read-only /root; keep host auth on boot storage.",
      "export HOME=/var/lib/mapache/host-home",
      "export DOCKER_CONFIG=/var/lib/mapache/host-home/.docker",
      "mkdir -p \"$DOCKER_CONFIG\"",
      "chmod 700 \"$HOME\" \"$DOCKER_CONFIG\"",
      `docker-credential-gcr configure-docker --registries=${shellQuote(image.split("/")[0])}`,
      `docker pull ${shellQuote(image)}`,
      "# The host pulls images; workspace code must not obtain the host identity.",
      "iptables -C DOCKER-USER -d 169.254.169.254/32 -p tcp --dport 80 -j REJECT 2>/dev/null || iptables -I DOCKER-USER 1 -d 169.254.169.254/32 -p tcp --dport 80 -j REJECT",
      "docker rm -f mapache-runner >/dev/null 2>&1 || true",
      `docker run -d --restart=unless-stopped --name mapache-runner --privileged=false -p 8080:8080 --shm-size=${shellQuote(options.shmSize || "2g")} ${runtimeMountArgs()} ${runtimeEnvArgs(descriptor, options)} ${shellQuote(image)}`,
    ].join("\n");
  }

  function runtimeEnvArgs(descriptor, options) {
    const functionBase = `https://${DEFAULT_FUNCTION_REGION}-${projectId}.cloudfunctions.net`;
    const env = {
      RUNTIME_PROVIDER: COMPUTE_ENGINE_BACKEND,
      MAPACHE_RETAINED_DISK_ROOT: "/var/lib/mapache/workspace",
      MAPACHE_DATA_DISK_NAME: descriptor.dataDiskName,
      MAPACHE_ALLOW_FORMAT_NEW_DISK: options.allowNewDisk === true ? "true" : "false",
      MAPACHE_RUNTIME_PROVIDER: COMPUTE_ENGINE_BACKEND,
      MAPACHE_AGENT_RUNTIME_GENERATION: String(descriptor.generation),
      MAPACHE_AUTOMATION_AGENT_TOKEN_URL: `${functionBase}/automationAgentToken`,
      MAPACHE_AUTOMATION_AGENT_API_URL: `${functionBase}/api`,
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
      "mapache-owner-uid": identityLabel(descriptor.ownerUid),
      "mapache-workspace-id": identityLabel(descriptor.workspaceId),
      "mapache-operation-id": identityLabel(String(options.operationId || descriptor.generation)),
      "mapache-runtime-provider": COMPUTE_ENGINE_BACKEND,
    };
  }

  function assertOwnership(resource, descriptor) {
    if (!hasOwnershipLabels(resource, descriptor)) {
      throw computeError("runtime_resource_ownership_mismatch", "Compute resource ownership labels do not match the admitted workspace");
    }
  }

  function hasOwnershipLabels(resource, descriptor) {
    const labels = resource?.labels || {};
    return labels["mapache-owner-uid"] === identityLabel(descriptor.ownerUid) &&
      labels["mapache-workspace-id"] === identityLabel(descriptor.workspaceId) &&
      labels["mapache-runtime-provider"] === COMPUTE_ENGINE_BACKEND;
  }

  function operationId(value) {
    const hash = createHash("sha256").update(String(value)).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  }

  function identityLabel(value) {
    // Firebase IDs may contain uppercase characters; GCE label values cannot.
    return createHash("sha256").update(String(value)).digest("hex").slice(0, 63);
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
