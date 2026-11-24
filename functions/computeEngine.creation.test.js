"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const {spawnSync} = require("node:child_process");
const {createHash} = require("node:crypto");
const {createComputeEngineService} = require("./computeEngine.service");
const {createRuntimeDescriptor} = require("./runtimeProvider.helpers");

function fixture() {
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "create-proof", ownerUid: "owner", generation: 1});
  const state = {disk: null, instance: null, diskCreates: 0, script: null, interrupt: false};
  const service = () => createComputeEngineService({projectId: "pi-agents-cloud", request: async req => {
    if (req.method === "GET") {
      const value = req.url.includes("/disks/") ? state.disk : state.instance;
      if (!value) throw Object.assign(new Error("missing"), {code: 404});
      return {data: structuredClone(value)}; // Never retain process-local properties.
    }
    if (req.method === "POST" && req.url.endsWith("/disks")) {
      state.diskCreates++;
      state.disk = {...req.data, status: "READY", users: [], selfLink: `${req.url}/${req.data.name}`};
      if (state.interrupt) throw new Error("worker lost after disk creation");
    } else if (req.method === "POST" && req.url.endsWith("/instances")) {
      state.instance = {...req.data, status: "RUNNING"};
      state.script = req.data.metadata.items.find(item => item.key === "startup-script").value;
    } else throw new Error("unexpected request");
    return {data: {status: "DONE"}};
  }});
  const options = {allowCreateDisk: true, operationId: "initial-create", runnerImage: "pinned"};
  return {state, descriptor, service, options};
}

// Run the generated bootstrap's storage section, with only device/system calls
// replaced. Real bash, directory checks and marker reads/writes exercise the
// destructive-operation boundary without needing a privileged loop device.
function boot(script, {signature = 2, marker, populated = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), "vm-bootstrap-"));
  try {
    if (marker) writeFileSync(join(root, ".mapache-vm-disk.json"), JSON.stringify(marker));
    if (populated) writeFileSync(join(root, "user-data"), "preserve");
    const storage = script.split("# Docker is invoked")[0].replaceAll("/var/lib/mapache/workspace", root);
    const stubs = `test() { if [ "$1" = -b ]; then return 0; else builtin test "$@"; fi; }
blkid() { return ${signature}; }
mountpoint() { return 0; }
mkfs.ext4() { echo formatted; }
`;
    const result = spawnSync("bash", ["-c", stubs + storage], {encoding: "utf8"});
    const markerPath = join(root, ".mapache-vm-disk.json");
    return {status: result.status, formatted: result.stdout.includes("formatted"),
      marker: existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : null};
  } finally { rmSync(root, {recursive: true, force: true}); }
}

test("a new process resumes initial disk creation using persisted operation and generation evidence", async () => {
  const f = fixture(); f.state.interrupt = true;
  await assert.rejects(f.service().start(f.descriptor, f.options), /worker lost/);
  f.state.interrupt = false;
  await f.service().start(f.descriptor, f.options);
  assert.equal(f.state.diskCreates, 1);
  const result = boot(f.state.script);
  assert.equal(result.status, 0);
  assert.equal(result.formatted, true);
  assert.equal(result.marker.workspaceId, "create-proof");
  assert.equal(result.marker.operationId, "initial-create");
  // If mkfs completed before interruption, initialize the still-empty ext4 root.
  assert.equal(boot(f.state.script, {signature: 0}).status, 0);
  assert.notEqual(boot(f.state.script, {signature: 4}).status, 0);
  assert.equal(boot(f.state.script, {signature: 4}).formatted, false);
  assert.notEqual(boot(f.state.script, {signature: 0, populated: true}).status, 0);
});

test("ordinary resume, another operation and a later generation cannot format or adopt an unmarked disk", async () => {
  for (const kind of ["resume", "operation", "generation", "legacy"]) {
    const f = fixture();
    await f.service().ensureDataDisk(f.descriptor, f.options);
    const options = {...f.options};
    let descriptor = f.descriptor;
    if (kind === "resume") options.allowCreateDisk = false;
    if (kind === "operation") options.operationId = "other-operation";
    if (kind === "generation") descriptor = {...descriptor, generation: 2, instanceName: null};
    if (kind === "legacy") delete f.state.disk.labels["mapache-created-generation"];
    await f.service().start(descriptor, options);
    for (const signature of [0, 2, 4]) {
      const result = boot(f.state.script, {signature});
      assert.notEqual(result.status, 0, `${kind}: unmarked disk must stop`);
      assert.equal(result.formatted, false);
      assert.equal(result.marker, null);
    }
    const marker = {workspaceId: "create-proof", ownerUid: "owner"};
    assert.equal(boot(f.state.script, {signature: 0, marker}).status, 0);
    assert.notEqual(boot(f.state.script, {signature: 0, marker: {...marker, ownerUid: "another"}}).status, 0);
  }
});

test("initial controller provisioning can initialize its confirmed disk without permission to recreate it", async () => {
  const f = fixture();
  await f.service().ensureDataDisk(f.descriptor, f.options);
  await assert.rejects(f.service().ensureDataDisk(f.descriptor, {...f.options, operationId: "other", requireCreationMatch: true}), /another creation/);
  await f.service().start(f.descriptor, {...f.options, allowCreateDisk: false, allowInitializeDisk: true});
  assert.equal(boot(f.state.script).status, 0);
  f.state.disk = null; f.state.instance = null;
  await assert.rejects(f.service().start(f.descriptor, {...f.options, allowCreateDisk: false, allowInitializeDisk: true}), error => error.code === "runtime_data_disk_missing");
  assert.equal(f.state.diskCreates, 1);
});

test("migration observation requires the exact creation operation and an unattached disk with a lossless provider ID", async () => {
  const f = fixture();
  const service = f.service();
  const request = {operationId: f.options.operationId};
  await service.ensureDataDisk(f.descriptor, f.options);
  const stringId = "9007199254740993";
  const zone = "https://compute.googleapis.com/compute/v1/projects/pi-agents-cloud/zones/" + f.descriptor.zone;
  Object.assign(f.state.disk, {id: stringId, zone});
  assert.deepEqual(await service.inspectMigrationDisk(f.descriptor, request),
      {diskId: stringId, diskName: f.descriptor.dataDiskName, zone: f.descriptor.zone, diskType: f.state.disk.type});
  await assert.rejects(service.inspectMigrationDisk(f.descriptor, {operationId: "another"}), {code: "runtime_data_disk_creation_conflict"});
  for (const invalid of [{id: Number(stringId)}, {users: ["foreign-instance"]}, {zone: "other-zone"}, {status: "CREATING"}]) {
    const previous = f.state.disk;
    f.state.disk = {...previous, ...invalid};
    await assert.rejects(service.inspectMigrationDisk(f.descriptor, request), {code: "runtime_migration_disk_unverified"});
    f.state.disk = previous;
  }
  assert.equal(f.state.diskCreates, 1);
});

test("maintenance observation binds the sole read-only attachment to the private instance ID", async () => {
  const f = fixture();
  const service = f.service();
  await service.ensureDataDisk(f.descriptor, f.options);
  const base = "https://www.googleapis.com/compute/v1/projects/pi-agents-cloud/zones/" + f.descriptor.zone;
  const maintenance = {instanceName: "maintenance", instanceId: "9007199254740994"};
  const timestamp = "2026-11-23T00:00:00.000Z";
  Object.assign(f.state.disk, {id: "9007199254740993", zone: base, users: [base + "/instances/maintenance"], lastAttachTimestamp: timestamp});
  const attachment = {source: base + "/disks/" + f.descriptor.dataDiskName,
    deviceName: f.descriptor.dataDiskName, boot: false, autoDelete: false, mode: "READ_ONLY"};
  f.state.instance = {id: maintenance.instanceId, name: maintenance.instanceName, status: "RUNNING",
    networkInterfaces: [{}], disks: [attachment]};
  const read = () => service.inspectMigrationDisk(f.descriptor, {operationId: f.options.operationId, maintenance});
  const observed = await read();
  assert.equal(observed.attachmentTimestamp, timestamp);
  assert.equal(observed.instanceId, maintenance.instanceId);
  attachment.mode = "READ_WRITE";
  await assert.rejects(read(), {code: "runtime_migration_maintenance_attachment_unverified"});
  attachment.mode = "READ_ONLY";
  f.state.instance.id = "9007199254740995";
  await assert.rejects(read(), {code: "runtime_migration_maintenance_attachment_unverified"});
  f.state.instance.id = maintenance.instanceId;
  f.state.disk.users.push(base + "/instances/another");
  await assert.rejects(read(), {code: "runtime_migration_maintenance_attachment_unverified"});
});

test("validation clone uses exact source identity and retries without another provider write", async () => {
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "clone-proof", ownerUid: "owner", generation: 1});
  const cloneDiskName = "mapache-val-disk-" + "b".repeat(24);
  const sourceDiskId = "9007199254740993";
  const operationId = "validation";
  const sourceOperationId = "import";
  const base = "https://compute.googleapis.com/compute/v1/projects/pi-agents-cloud/zones/" + descriptor.zone;
  const label = value => createHash("sha256").update(value).digest("hex").slice(0, 63);
  const source = {name: descriptor.dataDiskName, id: sourceDiskId, zone: base, status: "READY", users: [],
    labels: {"mapache-owner-uid": label("owner"), "mapache-workspace-id": label("clone-proof"),
      "mapache-created-generation": "1", "mapache-operation-id": label(sourceOperationId), "mapache-runtime-provider": "compute-engine"}};
  let clone;
  let writes = 0;
  const compute = createComputeEngineService({projectId: "pi-agents-cloud", request: async req => {
    if (req.method === "POST") {
      writes++;
      assert.equal(req.data.sourceDisk, base + "/disks/" + descriptor.dataDiskName);
      assert.equal(req.data.labels["mapache-validation-only"], "true");
      clone = {...req.data, sourceDiskId, id: "9007199254740994", status: "READY"};
      return {data: {status: "DONE"}};
    }
    const disk = req.url.endsWith(cloneDiskName) ? clone : source;
    if (!disk) throw Object.assign(Error("not found"), {code: 404});
    return {data: disk};
  }});
  const run = () => compute.ensureMigrationValidationClone(descriptor, {cloneDiskName, sourceDiskId,
    sourceOperationId, operationId, sourceLastAttachTimestamp: null});
  const result = await run();
  assert.deepEqual(await run(), result);
  assert.equal(writes, 1);
  clone.sourceDiskId = "9007199254740995";
  await assert.rejects(run(), {code: "runtime_validation_clone_unverified"});
  source.lastAttachTimestamp = "2026-11-23T00:00:00Z";
  await assert.rejects(run(), {code: "runtime_validation_source_disk_changed"});
  assert.equal(writes, 1);
});

test("validation cleanup deletes only the ID-checked clone instance and disk", async () => {
  const key = "c".repeat(24);
  const descriptor = createRuntimeDescriptor({backend: "compute-engine", workspaceId: "cleanup-proof", ownerUid: "owner", generation: 1,
    dataDiskName: `mapache-val-disk-${key}`, instanceName: `mapache-val-vm-${key}`});
  const operationId = `validate-${key}`;
  const sourceDiskId = "9007199254740993";
  const cloneDiskId = "9007199254740994";
  const base = "https://compute.googleapis.com/compute/v1/projects/pi-agents-cloud/zones/" + descriptor.zone;
  const label = value => createHash("sha256").update(value).digest("hex").slice(0, 63);
  const labels = {"mapache-owner-uid": label("owner"), "mapache-workspace-id": label("cleanup-proof"),
    "mapache-created-generation": "1", "mapache-operation-id": label(operationId), "mapache-runtime-provider": "compute-engine",
    "mapache-validation-only": "true"};
  const state = {
    disk: {name: descriptor.dataDiskName, id: cloneDiskId, sourceDiskId, zone: base, status: "READY", users: [], labels},
    instance: {id: "9007199254740995", name: descriptor.instanceName, status: "RUNNING", labels,
      disks: [{source: `${base}/disks/${descriptor.dataDiskName}`, deviceName: descriptor.dataDiskName,
        boot: false, autoDelete: false, mode: "READ_WRITE"}]},
  };
  const deleted = [];
  const compute = createComputeEngineService({projectId: "pi-agents-cloud", request: async req => {
    const isDisk = req.url.includes("/disks/");
    if (req.method === "GET") {
      const value = isDisk ? state.disk : state.instance;
      if (!value) throw Object.assign(Error("not found"), {code: 404});
      return {data: structuredClone(value)};
    }
    assert.equal(req.method, "DELETE");
    deleted.push(isDisk ? "disk" : "instance");
    if (isDisk) state.disk = null;
    else state.instance = null;
    return {data: {status: "DONE"}};
  }});
  const result = await compute.deleteMigrationValidationResources(descriptor, {operationId, cloneDiskId, sourceDiskId});
  assert.deepEqual(result, {instanceDeleted: true, diskDeleted: true, cloneDiskId, sourceDiskId});
  assert.deepEqual(deleted, ["instance", "disk"]);
  state.disk = {name: descriptor.dataDiskName, id: cloneDiskId, sourceDiskId: "9007199254740996", zone: base, status: "READY", users: [], labels};
  await assert.rejects(compute.deleteMigrationValidationResources(descriptor, {operationId, cloneDiskId, sourceDiskId}),
      {code: "runtime_validation_cleanup_unverified"});
  assert.deepEqual(deleted, ["instance", "disk"]);
});
