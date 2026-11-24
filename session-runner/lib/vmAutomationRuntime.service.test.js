"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {copyReadonlyTree, isolatedPort, spawnSandboxed} = require("./vmAutomationRuntime.service");

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-vm-automation-"));
  try {
    return await callback(directory);
  } finally {
    await makeDirectoriesWritable(directory);
    await fs.rm(directory, {force: true, recursive: true});
  }
}

async function makeDirectoriesWritable(directory) {
  await fs.chmod(directory, 0o700);
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    if (entry.isDirectory()) await makeDirectoriesWritable(path.join(directory, entry.name));
  }
}

test("copyReadonlyTree creates a filtered read-only workspace snapshot", async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    const outside = path.join(directory, "outside.txt");
    await fs.mkdir(path.join(source, "nested", ".mapache-internal"), {recursive: true});
    await fs.writeFile(path.join(source, "README.md"), "hello\n");
    await fs.writeFile(path.join(source, "nested", "value.txt"), "value\n");
    await fs.writeFile(path.join(source, "nested", ".mapache-internal", "secret"), "secret\n");
    await fs.symlink("nested/value.txt", path.join(source, "value-link"));
    await fs.writeFile(outside, "outside\n");

    await copyReadonlyTree(source, destination, {fsImpl: {promises: fs}});

    assert.equal(await fs.readFile(path.join(destination, "README.md"), "utf8"), "hello\n");
    assert.equal(await fs.readFile(path.join(destination, "nested", "value.txt"), "utf8"), "value\n");
    await assert.rejects(fs.access(path.join(destination, "nested", ".mapache-internal")));
    assert.equal(await fs.readlink(path.join(destination, "value-link")), "nested/value.txt");
    assert.equal((await fs.stat(path.join(destination, "README.md"))).mode & 0o777, 0o444);
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o555);
  });
});

test("copyReadonlyTree rejects symlinks that escape the workspace", async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(source, {recursive: true});
    await fs.writeFile(path.join(directory, "outside.txt"), "outside\n");
    await fs.symlink(path.join(directory, "outside.txt"), path.join(source, "outside-link"));

    await assert.rejects(
        copyReadonlyTree(source, destination, {fsImpl: {promises: fs}}),
        (error) => error?.code === "vm_automation_input_symlink_invalid",
    );
  });
});

test("isolatedPort is stable and stays in the private automation range", () => {
  const first = isolatedPort("run-605");
  assert.equal(first, isolatedPort("run-605"));
  assert.ok(first >= 8800 && first <= 8899);
});

test("spawnSandboxed keeps the launcher cwd on the host and hides the live workspace", () => {
  const calls = [];
  const outputRoot = "/var/lib/mapache/workspace/automation-runs/run-605/output";
  const stateRoot = "/var/lib/mapache/workspace/automation-runs/run-605/state";
  const result = spawnSandboxed({
    args: ["/usr/local/lib/pi-web-ui/index.js"],
    bwrapPath: "/usr/bin/bwrap",
    childConfig: {homeDir: `${stateRoot}/home`, originalWorkspaceDir: "/var/lib/mapache/workspace/workspace"},
    file: "/usr/bin/node",
    inputRoot: "/var/lib/mapache/workspace/automation-runs/run-605/input",
    options: {env: {KEEP: "1"}, stdio: ["ignore", "pipe", "pipe"]},
    outputRoot,
    spawnImpl: (...arguments_) => {
      calls.push(arguments_);
      return {pid: 1234};
    },
    stateRoot,
  });

  assert.deepEqual(result, {pid: 1234});
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/bwrap");
  assert.equal(calls[0][2].cwd, outputRoot);
  assert.equal(calls[0][2].env.WORKSPACE_DIR, "/workspace");
  assert.deepEqual(calls[0][1].slice(-2), ["/usr/bin/node", "/usr/local/lib/pi-web-ui/index.js"]);
  assert.ok(calls[0][1].includes("--unshare-user"));
  assert.ok(calls[0][1].includes("--ro-bind"));
  assert.ok(calls[0][1].includes("/workspace-input"));
  assert.ok(calls[0][1].includes("--tmpfs"));
});
