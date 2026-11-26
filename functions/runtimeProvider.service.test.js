"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRuntimeProviderService} = require("./runtimeProvider.service");
const {COMPUTE_ENGINE_BACKEND, REMOTE_LIBVIRT_BACKEND, createRuntimeDescriptor} = require("./runtimeProvider.helpers");

test("legacy sessions remain on Cloud Run while VM sessions dispatch to Compute Engine", async () => {
  const calls = [];
  const cloudRun = {
    provisionSessionService: async (...args) => { calls.push({kind: "cloud-run", args}); return "cloud"; },
    patchSessionService: async () => { calls.push("cloud-patch"); return "cloud-patch"; },
    deleteSessionService: async () => { calls.push("cloud-delete"); return true; },
  };
  const computeEngine = {
    provisionSessionService: async () => { calls.push("compute-engine"); return "compute"; },
    patchSessionService: async () => { calls.push("compute-patch"); return "compute-patch"; },
    deleteSessionService: async () => { calls.push("compute-delete"); return true; },
  };
  const service = createRuntimeProviderService({cloudRunService: cloudRun, computeEngineService: computeEngine});
  const legacy = {workspaceId: "workspace-1", ownerUid: "owner-1", id: "session-1"};
  const vm = {
    ...legacy,
    runtimeProvider: createRuntimeDescriptor({backend: COMPUTE_ENGINE_BACKEND, workspaceId: "workspace-1", ownerUid: "owner-1"}),
  };

  const workspace = {id: "workspace-1", ownerUid: "owner-1"};
  const sessionRef = {id: "session-1"};
  assert.equal(await service.provisionSessionService(workspace, sessionRef, legacy), "cloud");
  assert.equal(await service.provisionSessionService({}, {}, vm), "compute");
  assert.equal(await service.patchSessionService({}, vm), "compute-patch");
  assert.deepEqual(calls, [
    {kind: "cloud-run", args: [workspace, sessionRef, legacy]},
    "compute-engine",
    "compute-patch",
  ]);
});

test("provider dispatch fails closed for a missing VM implementation", async () => {
  const descriptor = createRuntimeDescriptor({backend: COMPUTE_ENGINE_BACKEND, workspaceId: "workspace-1", ownerUid: "owner-1"});
  const service = createRuntimeProviderService({cloudRunService: {provisionSessionService: async () => true}});
  await assert.rejects(
      service.provisionSessionService({}, {}, {workspaceId: "workspace-1", ownerUid: "owner-1", runtimeProvider: descriptor}),
      /compute_engine_provider_unavailable/,
  );
});

test("remote-libvirt dispatch is explicit and never falls back to Cloud Run", async () => {
  const calls = [];
  const cloudRun = {provisionSessionService: async () => { calls.push("cloud"); return "cloud"; }};
  const remote = {
    provisionSessionService: async () => { calls.push("remote"); return "remote"; },
    patchSessionService: async () => "remote-patch",
    deleteSessionService: async () => "remote-delete",
  };
  const descriptor = createRuntimeDescriptor({
    backend: REMOTE_LIBVIRT_BACKEND,
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    hostId: "host-1",
  });
  const service = createRuntimeProviderService({cloudRunService: cloudRun, remoteVmService: remote});
  assert.equal(await service.provisionSessionService({id: "workspace-1", ownerUid: "owner-1"}, {}, {
    workspaceId: "workspace-1", ownerUid: "owner-1", runtimeProvider: descriptor,
  }), "remote");
  assert.deepEqual(calls, ["remote"]);
  assert.equal(service.providerForSession({}, {runtimeProvider: descriptor}), remote);
});

test("remote-libvirt dispatch fails closed when the adapter is absent", async () => {
  const descriptor = createRuntimeDescriptor({
    backend: REMOTE_LIBVIRT_BACKEND,
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    hostId: "host-1",
  });
  const service = createRuntimeProviderService({cloudRunService: {provisionSessionService: async () => true}});
  await assert.rejects(
      service.provisionSessionService({}, {}, {workspaceId: "workspace-1", ownerUid: "owner-1", runtimeProvider: descriptor}),
      /remote_libvirt_provider_unavailable/,
  );
});
