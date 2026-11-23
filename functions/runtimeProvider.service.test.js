"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRuntimeProviderService} = require("./runtimeProvider.service");
const {COMPUTE_ENGINE_BACKEND, createRuntimeDescriptor} = require("./runtimeProvider.helpers");

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
