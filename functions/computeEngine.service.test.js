"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createHash} = require("node:crypto");
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
        instance = {name: request.data.name, status: "RUNNING", labels: request.data.labels, disks: request.data.disks, selfLink: `${request.url}/${request.data.name}`};
        return {data: {status: "DONE"}};
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    },
  });
  const result = await service.start(descriptor({ownerUid: "OwnerWithUppercase123", workspaceId: "WorkspaceID456"}), {allowCreateDisk: true, runnerImage: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:abc"});
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

function lifecycleFixture() {
  const d = descriptor();
  const prefix = "https://www.googleapis.com/compute/v1/projects/pi-agents-cloud/zones/us-central1-a";
  const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 63);
  const labels = {"mapache-owner-uid": hash(d.ownerUid), "mapache-workspace-id": hash(d.workspaceId), "mapache-runtime-provider": "compute-engine"};
  const state = {
    disk: {name: d.dataDiskName, selfLink: `${prefix}/disks/${d.dataDiskName}`, status: "READY", labels, users: []},
    instance: {name: d.instanceName, status: "RUNNING", labels,
      disks: [{boot: false, source: `${prefix}/disks/${d.dataDiskName}`, autoDelete: false, mode: "READ_WRITE"}]},
    mutations: [], leaveInstance: false, delete404: false,
  };
  const missing = () => Object.assign(new Error("missing"), {response: {status: 404}});
  const service = createComputeEngineService({projectId: "pi-agents-cloud", request: async request => {
    if (request.method === "GET") {
      const value = request.url.includes("/instances/") ? state.instance : state.disk;
      if (!value) throw missing();
      return {data: value};
    }
    state.mutations.push(request);
    if (request.method === "DELETE") {
      if (!state.leaveInstance) state.instance = null;
      if (state.delete404) throw missing();
      return {data: {status: "DONE"}};
    }
    throw new Error("unexpected mutation");
  }});
  return {state, service, d};
}

test("pause retains admission until instance absence and disk detachment are confirmed", async () => {
  const f = lifecycleFixture();
  f.state.leaveInstance = true;
  await assert.rejects(f.service.pause(f.d), error => error.code === "runtime_instance_deletion_pending");
  f.state.leaveInstance = false;
  f.state.disk.users = ["old-instance"];
  await assert.rejects(f.service.pause(f.d), error => error.code === "runtime_data_disk_attached");
  f.state.disk.users = [];
  const result = await f.service.pause(f.d);
  assert.equal(result.instanceDeleted, true);
  assert.equal(result.dataDiskRetained, true);
  assert.equal(f.state.mutations.length, 2, "reconciliation after confirmed absence does not delete again");
});

test("missing retained storage cannot be reported as a successful pause", async () => {
  const f = lifecycleFixture(); f.state.disk = null; f.state.instance = null;
  await assert.rejects(f.service.pause(f.d), error => error.code === "runtime_data_disk_missing");
  await assert.rejects(f.service.start(f.d), error => error.code === "runtime_data_disk_missing");
  assert.equal(f.state.mutations.length, 0);
});

test("duplicate delete racing with a completed worker reconciles safely", async () => {
  const f = lifecycleFixture(); f.state.delete404 = true;
  assert.equal((await f.service.pause(f.d)).state, "stopped");
  assert.equal(f.state.disk.name, f.d.dataDiskName);
});

test("start retries adopt only the correct retained attachment and never restart expired boots", async () => {
  const f = lifecycleFixture();
  assert.equal((await f.service.start(f.d)).instance.name, f.d.instanceName);
  assert.equal(f.state.mutations.length, 0);
  f.state.instance.status = "TERMINATED";
  await assert.rejects(f.service.start(f.d), error => error.code === "runtime_generation_replacement_required");
  f.state.instance.status = "RUNNING";
  for (const override of [{autoDelete: true}, {mode: "READ_ONLY"}, {source: "https://attacker.example/disks/data"}]) {
    const original = f.state.instance.disks[0];
    f.state.instance.disks[0] = {...original, ...override};
    await assert.rejects(f.service.start(f.d), error => error.code === "runtime_data_disk_attachment_mismatch");
    f.state.instance.disks[0] = original;
  }
  assert.equal(f.state.mutations.length, 0);
});

test("replacement cannot attach while another instance is still a disk user", async () => {
  const f = lifecycleFixture(); f.state.instance = null; f.state.disk.users = ["old-instance"];
  await assert.rejects(f.service.start(f.d, {runnerImage: "pinned"}), error => error.code === "runtime_data_disk_attached");
  assert.equal(f.state.mutations.length, 0);
});

test("imported-disk cleanup requires the exact detached operation-owned disk", async () => {
  const d = descriptor({generation: 3});
  const label = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 63);
  const state = {disk: {name: d.dataDiskName, id: "123", status: "READY", users: [],
    labels: {"mapache-owner-uid": label(d.ownerUid), "mapache-workspace-id": label(d.workspaceId),
      "mapache-runtime-provider": COMPUTE_ENGINE_BACKEND, "mapache-created-generation": "3",
      "mapache-operation-id": label("destination")}}, mutations: []};
  const missing = () => Object.assign(new Error("missing"), {response: {status: 404}});
  const service = createComputeEngineService({projectId: "pi-agents-cloud", request: async request => {
    if (request.method === "GET") {
      if (!state.disk) throw missing();
      return {data: state.disk};
    }
    state.mutations.push(request);
    if (request.method === "DELETE") {
      state.disk = null;
      return {data: {status: "DONE"}};
    }
    throw new Error(`unexpected ${request.method} ${request.url}`);
  }});

  const result = await service.deleteMigrationImportedDisk(d, {operationId: "destination", diskId: "123"});
  assert.deepEqual(result, {diskDeleted: true, diskId: "123"});
  assert.equal(state.mutations.length, 1);

  state.disk = {name: d.dataDiskName, id: "123", status: "READY", users: ["attached-instance"], labels: {
    "mapache-owner-uid": label(d.ownerUid), "mapache-workspace-id": label(d.workspaceId),
    "mapache-runtime-provider": COMPUTE_ENGINE_BACKEND, "mapache-created-generation": "3",
    "mapache-operation-id": label("destination")}};
  await assert.rejects(service.deleteMigrationImportedDisk(d, {operationId: "destination", diskId: "123"}),
      error => error.code === "runtime_migration_disk_cleanup_unverified");
  assert.equal(state.mutations.length, 1);
});

test("migration runtime inspection binds the attached disk and private running instance", async () => {
  const d = descriptor({generation: 4});
  const label = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 63);
  const prefix = "https://compute.googleapis.com/compute/v1/projects/pi-agents-cloud/zones/us-central1-a";
  const state = {
    disk: {name: d.dataDiskName, id: "456", status: "READY", lastAttachTimestamp: "2026-11-24T04:00:00Z",
      zone: prefix,
      users: [`${prefix}/instances/${d.instanceName}`],
      labels: {"mapache-owner-uid": label(d.ownerUid), "mapache-workspace-id": label(d.workspaceId),
        "mapache-runtime-provider": COMPUTE_ENGINE_BACKEND, "mapache-created-generation": "4",
        "mapache-operation-id": label("destination")}},
    instance: {name: d.instanceName, id: "789", status: "RUNNING",
      labels: {"mapache-owner-uid": label(d.ownerUid), "mapache-workspace-id": label(d.workspaceId),
        "mapache-runtime-provider": COMPUTE_ENGINE_BACKEND},
      networkInterfaces: [{networkIP: "10.0.0.7"}],
      disks: [{boot: false, source: `${prefix}/disks/${d.dataDiskName}`, autoDelete: false, mode: "READ_WRITE",
        deviceName: d.dataDiskName}]},
  };
  const service = createComputeEngineService({projectId: "pi-agents-cloud", request: async request => {
    if (request.method !== "GET") throw new Error(`unexpected ${request.method} ${request.url}`);
    return {data: request.url.includes("/instances/") ? state.instance : state.disk};
  }});
  const result = await service.inspectMigrationRuntime(d, {operationId: "destination", diskId: "456"});
  assert.deepEqual(result, {diskId: "456", diskName: d.dataDiskName, zone: d.zone, attached: true,
    instanceId: "789", instanceName: d.instanceName, instanceReady: true, attachmentTimestamp: "2026-11-24T04:00:00Z"});
  state.instance.disks[0].mode = "READ_ONLY";
  await assert.rejects(service.inspectMigrationRuntime(d, {operationId: "destination", diskId: "456"}),
      error => error.code === "runtime_migration_runtime_unverified");
});
