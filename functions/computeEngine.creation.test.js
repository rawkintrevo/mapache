"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const {spawnSync} = require("node:child_process");
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
