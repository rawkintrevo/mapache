"use strict";

const crypto = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");

const RUNTIME_DESCRIPTOR_VERSION = 1;
const CLOUD_RUN_BACKEND = "cloud-run";
const COMPUTE_ENGINE_BACKEND = "compute-engine";
const SSH_BACKEND = "ssh";
const REMOTE_LIBVIRT_BACKEND = "remote-libvirt";
const REMOTE_GUEST_IMAGE_VERSION = "ubuntu-24.04-v2";
const REMOTE_GUEST_VCPUS = 2;
const REMOTE_GUEST_MEMORY_MIB = 8192;
const REMOTE_GUEST_DISK_GIB = 40;
const SUPPORTED_BACKENDS = new Set([
  CLOUD_RUN_BACKEND,
  COMPUTE_ENGINE_BACKEND,
  SSH_BACKEND,
  REMOTE_LIBVIRT_BACKEND,
]);

function runtimeDescriptorError(code, details = {}) {
  const error = httpError(409, code);
  error.code = code;
  error.publicMessage = code;
  Object.assign(error, details);
  return error;
}

function normalizeRuntimeBackend(value) {
  const backend = String(value || "").trim().toLowerCase();
  return SUPPORTED_BACKENDS.has(backend) ? backend : "";
}

function safeIdentifier(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 128 || /[^A-Za-z0-9_.-]/.test(normalized)) {
    throw runtimeDescriptorError("runtime_provider_descriptor_invalid", {field: label});
  }
  return normalized;
}

function workspaceDiskName(workspaceId) {
  const digest = crypto.createHash("sha256").update(String(workspaceId || "")).digest("hex").slice(0, 24);
  return `mapache-ws-${digest}`;
}

function instanceName(workspaceId, generation = 0) {
  const digest = crypto.createHash("sha256")
      .update(`${String(workspaceId || "")}:${Number(generation) || 0}`)
      .digest("hex")
      .slice(0, 24);
  return `mapache-vm-${digest}`;
}

function remoteGuestName(workspaceId) {
  return workspaceDiskName(workspaceId);
}

function remoteDiskName(workspaceId) {
  return `${remoteGuestName(workspaceId)}.qcow2`;
}

function normalizeRuntimeDescriptor(value, {workspaceId, ownerUid, allowMissing = false} = {}) {
  if (value == null || value === "") {
    if (allowMissing) return null;
    throw runtimeDescriptorError("runtime_provider_descriptor_missing");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeDescriptorError("runtime_provider_descriptor_invalid");
  }
  const version = Number(value.version);
  const backend = normalizeRuntimeBackend(value.backend);
  if (version !== RUNTIME_DESCRIPTOR_VERSION || !backend) {
    throw runtimeDescriptorError("runtime_provider_descriptor_invalid");
  }
  if (workspaceId && value.workspaceId !== workspaceId) {
    throw runtimeDescriptorError("runtime_provider_descriptor_owner_mismatch");
  }
  if (ownerUid && value.ownerUid !== ownerUid) {
    throw runtimeDescriptorError("runtime_provider_descriptor_owner_mismatch");
  }
  const descriptor = {
    version,
    backend,
    workspaceId: safeIdentifier(value.workspaceId || workspaceId, "workspaceId"),
    ownerUid: safeIdentifier(value.ownerUid || ownerUid, "ownerUid"),
    region: safeIdentifier(value.region || "us-central1", "region"),
    zone: value.zone ? safeIdentifier(value.zone, "zone") : null,
    generation: Number.isSafeInteger(Number(value.generation)) && Number(value.generation) > 0 ? Number(value.generation) : 1,
    dataDiskName: value.dataDiskName ? safeIdentifier(value.dataDiskName, "dataDiskName") : null,
    instanceName: value.instanceName ? safeIdentifier(value.instanceName, "instanceName") : null,
    gateway: normalizeGateway(value.gateway),
    state: String(value.state || "stopped").trim().toLowerCase() || "stopped",
    desiredConfigVersion: Number.isSafeInteger(Number(value.desiredConfigVersion)) ? Number(value.desiredConfigVersion) : 0,
    hostId: value.hostId ? safeIdentifier(value.hostId, "hostId") : null,
    guestImageVersion: String(value.guestImageVersion || REMOTE_GUEST_IMAGE_VERSION),
    guestName: value.guestName ? safeIdentifier(value.guestName, "guestName") : null,
    guestIp: value.guestIp ? String(value.guestIp).trim() : null,
    guestResources: value.guestResources && typeof value.guestResources === "object" ? {
      vcpus: Number(value.guestResources.vcpus ?? REMOTE_GUEST_VCPUS),
      memoryMiB: Number(value.guestResources.memoryMiB ?? REMOTE_GUEST_MEMORY_MIB),
      diskGiB: Number(value.guestResources.diskGiB ?? REMOTE_GUEST_DISK_GIB),
    } : {
      vcpus: REMOTE_GUEST_VCPUS,
      memoryMiB: REMOTE_GUEST_MEMORY_MIB,
      diskGiB: REMOTE_GUEST_DISK_GIB,
    },
  };
  if (backend === COMPUTE_ENGINE_BACKEND) {
    descriptor.zone = descriptor.zone || `${descriptor.region}-a`;
    descriptor.dataDiskName = descriptor.dataDiskName || workspaceDiskName(descriptor.workspaceId);
    descriptor.instanceName = descriptor.instanceName || instanceName(descriptor.workspaceId, descriptor.generation);
  }
  if (backend === REMOTE_LIBVIRT_BACKEND) {
    descriptor.hostId = safeIdentifier(descriptor.hostId, "hostId");
    descriptor.guestImageVersion = descriptor.guestImageVersion || REMOTE_GUEST_IMAGE_VERSION;
    descriptor.guestName = descriptor.guestName || remoteGuestName(descriptor.workspaceId);
    descriptor.dataDiskName = descriptor.dataDiskName || remoteDiskName(descriptor.workspaceId);
    descriptor.instanceName = descriptor.instanceName || descriptor.guestName;
    if (descriptor.guestName !== remoteGuestName(descriptor.workspaceId) ||
        descriptor.dataDiskName !== remoteDiskName(descriptor.workspaceId) ||
        descriptor.instanceName !== descriptor.guestName) {
      throw runtimeDescriptorError("runtime_provider_descriptor_invalid", {field: "guestIdentity"});
    }
    if (!/^ubuntu-24\.04-v[0-9]+$/.test(descriptor.guestImageVersion)) {
      throw runtimeDescriptorError("runtime_provider_descriptor_invalid", {field: "guestImageVersion"});
    }
    if (!Number.isInteger(descriptor.guestResources.vcpus) || descriptor.guestResources.vcpus < 1 || descriptor.guestResources.vcpus > 64 ||
        !Number.isInteger(descriptor.guestResources.memoryMiB) || descriptor.guestResources.memoryMiB < 1024 ||
        descriptor.guestResources.memoryMiB > 262144 || descriptor.guestResources.memoryMiB % 1024 !== 0 ||
        descriptor.guestResources.diskGiB !== REMOTE_GUEST_DISK_GIB) {
      throw runtimeDescriptorError("runtime_provider_descriptor_invalid", {field: "guestResources"});
    }
  }
  return descriptor;
}

function normalizeGateway(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeDescriptorError("runtime_provider_descriptor_invalid", {field: "gateway"});
  }
  const baseUrl = String(value.baseUrl || "").trim();
  if (!baseUrl) return null;
  let url;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw runtimeDescriptorError("runtime_provider_gateway_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw runtimeDescriptorError("runtime_provider_gateway_invalid");
  }
  return {baseUrl: url.origin};
}

function createRuntimeDescriptor({backend, workspaceId, ownerUid, region, zone, generation, dataDiskName, instanceName: vmName, gateway, desiredConfigVersion, hostId, guestImageVersion, guestName, guestIp, guestResources} = {}) {
  return normalizeRuntimeDescriptor({
    version: RUNTIME_DESCRIPTOR_VERSION,
    backend,
    workspaceId,
    ownerUid,
    region,
    zone,
    generation,
    dataDiskName,
    instanceName: vmName,
    gateway,
    desiredConfigVersion,
    hostId,
    guestImageVersion,
    guestName,
    guestIp,
    guestResources,
  }, {workspaceId, ownerUid});
}

function runtimeDescriptorForWorkspace(workspace = {}, {workspaceId, ownerUid, region, generation} = {}) {
  const descriptor = workspace.runtimeProvider || workspace.runtimeProviderDescriptor;
  if (descriptor) return normalizeRuntimeDescriptor(descriptor, {
    workspaceId: workspaceId || workspace.id,
    ownerUid: ownerUid || workspace.ownerUid,
  });
  if (workspace.runtimeProviderVersion || workspace.runtimeBackend) {
    return createRuntimeDescriptor({
      backend: workspace.runtimeBackend,
      workspaceId: workspaceId || workspace.id,
      ownerUid: ownerUid || workspace.ownerUid,
      region: region || workspace.region,
      generation,
      desiredConfigVersion: workspace.machineConfig?.desiredVersion,
    });
  }
  return null;
}

function runtimeDescriptorForSession(workspace = {}, session = {}) {
  const descriptor = session.runtimeProvider || session.runtimeProviderDescriptor ||
    runtimeDescriptorForWorkspace(workspace, {
      workspaceId: session.workspaceId || workspace.id,
      ownerUid: session.ownerUid || workspace.ownerUid,
      region: session.region,
      generation: session.agentRuntimeGeneration,
    });
  if (!descriptor) return createRuntimeDescriptor({
    backend: CLOUD_RUN_BACKEND,
    workspaceId: session.workspaceId || workspace.id,
    ownerUid: session.ownerUid || workspace.ownerUid,
    region: session.region,
    generation: session.agentRuntimeGeneration,
  });
  return normalizeRuntimeDescriptor(descriptor, {
    workspaceId: session.workspaceId || workspace.id,
    ownerUid: session.ownerUid || workspace.ownerUid,
  });
}

function isComputeEngineRuntime(value = {}) {
  const descriptor = value.runtimeProvider || value.runtimeProviderDescriptor || value;
  return normalizeRuntimeBackend(descriptor.backend) === COMPUTE_ENGINE_BACKEND;
}

function isRemoteLibvirtRuntime(value = {}) {
  const descriptor = value.runtimeProvider || value.runtimeProviderDescriptor || value;
  return normalizeRuntimeBackend(descriptor.backend) === REMOTE_LIBVIRT_BACKEND;
}

function isRuntimeProviderEnabled(env = process.env) {
  return String(env.VM_WORKSPACE_RUNTIME_ENABLED || "").trim().toLowerCase() === "true";
}

module.exports = {
  CLOUD_RUN_BACKEND,
  COMPUTE_ENGINE_BACKEND,
  REMOTE_LIBVIRT_BACKEND,
  REMOTE_GUEST_DISK_GIB,
  REMOTE_GUEST_IMAGE_VERSION,
  REMOTE_GUEST_MEMORY_MIB,
  REMOTE_GUEST_VCPUS,
  RUNTIME_DESCRIPTOR_VERSION,
  SSH_BACKEND,
  createRuntimeDescriptor,
  instanceName,
  isComputeEngineRuntime,
  isRemoteLibvirtRuntime,
  isRuntimeProviderEnabled,
  normalizeRuntimeBackend,
  normalizeRuntimeDescriptor,
  remoteDiskName,
  remoteGuestName,
  runtimeDescriptorError,
  runtimeDescriptorForSession,
  runtimeDescriptorForWorkspace,
  workspaceDiskName,
};
