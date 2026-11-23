"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CLOUD_RUN_BACKEND,
  COMPUTE_ENGINE_BACKEND,
  createRuntimeDescriptor,
  instanceName,
  normalizeRuntimeDescriptor,
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
