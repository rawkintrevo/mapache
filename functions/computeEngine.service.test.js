"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createComputeEngineService} = require("./computeEngine.service");
const {normalizeComputeEngineLabelValue} = require("./computeEngineLabels.helpers");
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

test("mixed-case Firebase workspace IDs produce valid Compute Engine labels", async () => {
  const calls = [];
  let disk;
  let instance;
  const service = createComputeEngineService({
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
        disk = {name: request.data.name, status: "READY", sizeGb: request.data.sizeGb, labels: request.data.labels};
        return {data: {status: "DONE"}};
      }
      if (request.method === "POST" && request.url.endsWith("/instances")) {
        instance = {name: request.data.name, status: "RUNNING", labels: request.data.labels};
        return {data: {status: "DONE"}};
      }
      return {data: {status: "DONE"}};
    },
  });
  await service.start(descriptor({workspaceId: "CWgOpYpwJTY4Cd5mwPEo"}), {
    runnerImage: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:abc",
  });
  const diskRequest = calls.find((call) => call.method === "POST" && call.url.endsWith("/disks"));
  const instanceRequest = calls.find((call) => call.method === "POST" && call.url.endsWith("/instances"));
  assert.notEqual(diskRequest.params.requestId, instanceRequest.params.requestId);
  assert.match(diskRequest.params.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(instanceRequest.params.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (const request of [diskRequest, instanceRequest]) {
    assert.equal(request.data.labels["mapache-workspace-id"], normalizeComputeEngineLabelValue("CWgOpYpwJTY4Cd5mwPEo"));
    assert.match(request.data.labels["mapache-workspace-id"], /^[a-z][a-z0-9_-]*$/);
  }
});

test("Compute Engine session deletion publishes the stopped lifecycle state", async () => {
  const stopped = [];
  const rawDescriptor = descriptor();
  const normalizedOwner = normalizeComputeEngineLabelValue(rawDescriptor.ownerUid);
  const normalizedWorkspace = normalizeComputeEngineLabelValue(rawDescriptor.workspaceId);
  const service = createComputeEngineService({
    request: async (request) => {
      if (request.method === "GET" && request.url.includes("/instances/")) {
        return {
          data: {
            name: rawDescriptor.instanceName,
            status: "RUNNING",
            labels: {
              "mapache-owner-uid": normalizedOwner,
              "mapache-workspace-id": normalizedWorkspace,
              "mapache-runtime-provider": COMPUTE_ENGINE_BACKEND,
            },
          },
        };
      }
      if (request.method === "DELETE" && request.url.includes("/instances/")) {
        return {data: {status: "DONE"}};
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    },
    markSessionStopped: async (sessionRef, session, reason) => {
      stopped.push({sessionRef, session, reason});
    },
  });
  const sessionRef = {id: "session-1"};
  const session = {runtimeProvider: rawDescriptor};

  const result = await service.deleteSessionService(sessionRef, session, {reason: "manual"});

  assert.deepEqual(result, {serviceAbsent: true, dataDiskRetained: true});
  assert.deepEqual(stopped, [{sessionRef, session, reason: "manual"}]);
});
