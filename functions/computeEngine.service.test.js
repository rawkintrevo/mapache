"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createComputeEngineService} = require("./computeEngine.service");
const {createRuntimeDescriptor, COMPUTE_ENGINE_BACKEND} = require("./runtimeProvider.helpers");

function descriptor(overrides = {}) {
  return createRuntimeDescriptor({
    backend: COMPUTE_ENGINE_BACKEND,
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    region: "us-central1",
    zone: "us-central1-a",
    ...overrides,
  });
}

test("VM startup creates a labeled retained disk and a private instance without konlet", async () => {
  const calls = [];
  let disk;
  let instance;
  const service = createComputeEngineService({
    projectId: "pi-agents-cloud",
    runnerServiceAccount: "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com",
    request: async (request) => {
      calls.push(request);
      if (request.method === "GET" && request.url.includes("/disks/")) {
        if (!disk) throw Object.assign(new Error("missing"), {response: {status: 404}});
        return {data: disk};
      }
      if (request.method === "GET" && request.url.includes("/instances/")) {
        if (!instance) throw Object.assign(new Error("missing"), {response: {status: 404}});
        return {data: instance};
      }
      if (request.method === "POST" && request.url.endsWith("/disks")) {
        disk = {name: request.data.name, selfLink: `${request.url}/${request.data.name}`, status: "READY", sizeGb: request.data.sizeGb, labels: request.data.labels};
        return {data: {status: "DONE"}};
      }
      if (request.method === "POST" && request.url.endsWith("/instances")) {
        instance = {name: request.data.name, status: "RUNNING", labels: request.data.labels, selfLink: `${request.url}/${request.data.name}`};
        return {data: {status: "DONE"}};
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    },
  });
  const result = await service.start(descriptor(), {runnerImage: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:abc"});
  assert.equal(result.state, "running");
  const instanceRequest = calls.find((call) => call.method === "POST" && call.url.endsWith("/instances"));
  assert.equal(instanceRequest.data.disks[1].autoDelete, false);
  assert.match(instanceRequest.data.metadata.items[0].value, /docker run/);
  assert.doesNotMatch(instanceRequest.data.metadata.items[0].value, /gce-container-declaration|konlet/);
  assert.match(instanceRequest.data.metadata.items[0].value, /runner\/health|MAPACHE_RUNTIME_PROVIDER|mapache-runner/);
});

test("ownership labels prevent cleanup of another workspace", async () => {
  const service = createComputeEngineService({
    request: async (request) => {
      if (request.method === "GET" && request.url.includes("/instances/")) {
        return {data: {name: "foreign", status: "RUNNING", labels: {"mapache-owner-uid": "other", "mapache-workspace-id": "other", "mapache-runtime-provider": "compute-engine"}}};
      }
      throw Object.assign(new Error("missing"), {response: {status: 404}});
    },
  });
  await assert.rejects(service.pause(descriptor()), /ownership/);
});
