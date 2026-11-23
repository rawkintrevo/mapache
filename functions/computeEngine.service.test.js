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
  const result = await service.start(descriptor({ownerUid: "OwnerWithUppercase123", workspaceId: "WorkspaceID456"}), {runnerImage: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:abc"});
  assert.equal(result.state, "running");
  const instanceRequest = calls.find((call) => call.method === "POST" && call.url.endsWith("/instances"));
  assert.equal(instanceRequest.data.disks[1].autoDelete, false);
  assert.equal(instanceRequest.data.disks[1].deviceName, result.descriptor.dataDiskName);
  for (const value of Object.values(instanceRequest.data.labels)) {
    assert.match(value, /^[a-z0-9_-]{1,63}$/);
  }
  const script = instanceRequest.data.metadata.items.find((item) => item.key === "startup-script").value;
  assert.ok(script.indexOf("OWNER_UID=") < script.indexOf("grep -q"));
  assert.ok(script.indexOf("WORKSPACE_ID=") < script.indexOf("grep -q"));
  const diskRequest = calls.find((call) => call.method === "POST" && call.url.endsWith("/disks"));
  const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/;
  assert.match(diskRequest.params.requestId, uuidPattern);
  assert.match(instanceRequest.params.requestId, uuidPattern);
  assert.notEqual(diskRequest.params.requestId, instanceRequest.params.requestId);
  assert.match(script, /mkfs.ext4 -L mapache-data/);
  assert.match(script, /docker run/);
  assert.doesNotMatch(script, /gce-container-declaration|konlet/);
  assert.match(script, /runner\/health|MAPACHE_RUNTIME_PROVIDER|mapache-runner/);
  assert.match(script, /DOCKER-USER.*169\.254\.169\.254/);
  assert.equal(instanceRequest.data.networkInterfaces[0].accessConfigs, undefined);
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
