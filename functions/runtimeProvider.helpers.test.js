"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CLOUD_RUN_BACKEND,
  COMPUTE_ENGINE_BACKEND,
  REMOTE_LIBVIRT_BACKEND,
  REMOTE_GUEST_DISK_GIB,
  REMOTE_GUEST_MEMORY_MIB,
  REMOTE_GUEST_VCPUS,
  createRuntimeDescriptor,
  instanceName,
  isRemoteLibvirtRuntime,
  normalizeRuntimeDescriptor,
  remoteDiskName,
  remoteGuestName,
  runtimeDescriptorForSession,
  workspaceDiskName,
} = require("./runtimeProvider.helpers");

test("runtime descriptors are stable and backend-owned", () => {
  const descriptor = createRuntimeDescriptor({
    backend: COMPUTE_ENGINE_BACKEND,
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    region: "us-central1",
    generation: 3,
  });
  assert.equal(descriptor.dataDiskName, workspaceDiskName("workspace-1"));
  assert.equal(descriptor.instanceName, instanceName("workspace-1", 3));
  assert.throws(() => normalizeRuntimeDescriptor({...descriptor, ownerUid: "owner-2"}, {
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
  }), /owner_mismatch/);
});

test("legacy sessions select Cloud Run while stored VM authority remains explicit", () => {
  const legacy = runtimeDescriptorForSession({id: "workspace-1", ownerUid: "owner-1"}, {
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    region: "us-central1",
  });
  assert.equal(legacy.backend, CLOUD_RUN_BACKEND);

  const vm = runtimeDescriptorForSession({id: "workspace-1", ownerUid: "owner-1"}, {
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    runtimeProvider: createRuntimeDescriptor({
      backend: COMPUTE_ENGINE_BACKEND,
      workspaceId: "workspace-1",
      ownerUid: "owner-1",
    }),
  });
  assert.equal(vm.backend, COMPUTE_ENGINE_BACKEND);
});

test("invalid stored providers fail instead of silently falling back", () => {
  assert.throws(() => runtimeDescriptorForSession({id: "workspace-1", ownerUid: "owner-1"}, {
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    runtimeProvider: {version: 99, backend: COMPUTE_ENGINE_BACKEND},
  }), /runtime_provider_descriptor_invalid/);
});

test("remote-libvirt descriptors pin the guest identity and fixed v1 resources", () => {
  const descriptor = createRuntimeDescriptor({
    backend: REMOTE_LIBVIRT_BACKEND,
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    hostId: "host-1",
  });
  assert.equal(descriptor.guestName, remoteGuestName("workspace-1"));
  assert.equal(descriptor.dataDiskName, remoteDiskName("workspace-1"));
  assert.deepEqual(descriptor.guestResources, {
    vcpus: REMOTE_GUEST_VCPUS,
    memoryMiB: REMOTE_GUEST_MEMORY_MIB,
    diskGiB: REMOTE_GUEST_DISK_GIB,
  });
  assert.equal(isRemoteLibvirtRuntime(descriptor), true);
  assert.throws(() => normalizeRuntimeDescriptor({...descriptor, hostId: "../other"}), /descriptor_invalid/);
  assert.throws(() => normalizeRuntimeDescriptor({...descriptor, guestName: "unmanaged-vm"}), /descriptor_invalid/);
});
