"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {spawn: defaultSpawn} = require("node:child_process");
const {createPiWebUiProcess} = require("./piWebUiProcess");

const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";
const AUTOMATION_ROOT_NAME = "automation-runs";

/**
 * Creates an isolated, browserless Pi runtime for one VM automation run.
 *
 * The canonical VM runner remains the workspace writer. The automation child
 * gets a private output tree and a filesystem snapshot of the workspace. The
 * snapshot is mounted read-only inside a bubblewrap user/mount namespace; the
 * child cannot reach the live retained workspace through /workspace because
 * that path is replaced by the output bind mount and the host workspace path
 * is hidden before the process starts.
 */
function createVmAutomationRuntimeFactory({
  config = {},
  fsImpl = fs,
  logger = console,
  randomId = () => crypto.randomUUID(),
  spawnImpl = defaultSpawn,
} = {}) {
  return async function createRuntime({onExit, runId} = {}) {
    assertConfiguration(config);
    const identity = normalizeRunId(runId);
    const root = path.join(config.retainedDiskRoot, AUTOMATION_ROOT_NAME, identity);
    const stateRoot = path.join(root, "state");
    const inputRoot = path.join(root, "input");
    const outputRoot = path.join(root, "output");
    await prepareDirectories({fsImpl, inputRoot, outputRoot, stateRoot});
    await copyReadonlyTree(config.workspaceDir, inputRoot, {fsImpl});
    await materializeRuntimeState({config, fsImpl, randomId, stateRoot});

    const childConfig = runtimeConfig(config, {identity, outputRoot, stateRoot});
    const process = createPiWebUiProcess(childConfig, {
      fs: fsImpl,
      logger,
      onExit,
      spawn: (file, args, options) => spawnSandboxed({
        args,
        bwrapPath: config.vmAutomationBwrapPath || DEFAULT_BWRAP_PATH,
        childConfig,
        file,
        inputRoot,
        options,
        outputRoot,
        spawnImpl,
        stateRoot,
      }),
    });

    return {
      inputPath: "/workspace-input",
      outputPath: outputRoot,
      process,
      async cleanup() {
        await process.stop().catch(() => {});
        await fsImpl.promises.rm(stateRoot, {force: true, recursive: true});
        await fsImpl.promises.rm(inputRoot, {force: true, recursive: true});
      },
    };
  };
}

function assertConfiguration(config) {
  if (config.runtimeProvider !== "compute-engine" || config.retainedDiskMode !== true ||
      !config.retainedDiskRoot || !config.workspaceDir || !config.piWebUiRoot) {
    throw runtimeError("vm_automation_runtime_configuration_invalid");
  }
}

function normalizeRunId(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) {
    throw runtimeError("vm_automation_run_id_invalid");
  }
  return normalized;
}

async function prepareDirectories({fsImpl, inputRoot, outputRoot, stateRoot}) {
  await Promise.all([
    fsImpl.promises.mkdir(inputRoot, {recursive: true, mode: 0o700}),
    fsImpl.promises.mkdir(outputRoot, {recursive: true, mode: 0o700}),
    fsImpl.promises.mkdir(path.join(stateRoot, "home"), {recursive: true, mode: 0o700}),
    fsImpl.promises.mkdir(path.join(stateRoot, "pi"), {recursive: true, mode: 0o700}),
    fsImpl.promises.mkdir(path.join(stateRoot, "sessions"), {recursive: true, mode: 0o700}),
    fsImpl.promises.mkdir(path.join(stateRoot, "ui"), {recursive: true, mode: 0o700}),
  ]);
}

async function copyReadonlyTree(sourceRoot, destinationRoot, {fsImpl}) {
  const sourceStat = await fsImpl.promises.lstat(sourceRoot);
  if (!sourceStat.isDirectory()) throw runtimeError("vm_automation_workspace_not_directory");
  await copyEntry(sourceRoot, destinationRoot, sourceRoot, {fsImpl});
  await fsImpl.promises.chmod(destinationRoot, 0o555);
}

async function copyEntry(source, destination, sourceRoot, {fsImpl}) {
  const stat = await fsImpl.promises.lstat(source);
  if (stat.isSymbolicLink()) {
    const target = await fsImpl.promises.readlink(source);
    const resolved = path.resolve(path.dirname(source), target);
    if (path.relative(sourceRoot, resolved).startsWith("..")) {
      throw runtimeError("vm_automation_input_symlink_invalid");
    }
    await fsImpl.promises.symlink(target, destination);
    return;
  }
  if (stat.isDirectory()) {
    // Populate the snapshot before applying its final read-only mode. This
    // must work for runner images that do not execute the copy as root.
    await fsImpl.promises.mkdir(destination, {recursive: true, mode: 0o700});
    const entries = await fsImpl.promises.readdir(source, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.name === ".mapache-internal") continue;
      await copyEntry(path.join(source, entry.name), path.join(destination, entry.name), sourceRoot, {fsImpl});
    }
    await fsImpl.promises.chmod(destination, 0o555);
    return;
  }
  if (!stat.isFile()) throw runtimeError("vm_automation_input_entry_invalid");
  await fsImpl.promises.copyFile(source, destination);
  await fsImpl.promises.chmod(destination, 0o444);
}

async function materializeRuntimeState({config, fsImpl, randomId, stateRoot}) {
  const sourceAgentDir = config.piWebUiPiDir || config.piAgentDir;
  const targetAgentDir = path.join(stateRoot, "pi");
  await copyOptionalTree(sourceAgentDir, targetAgentDir, {fsImpl});
  if (config.piMcpConfigPath) {
    await copyOptionalFile(config.piMcpConfigPath, path.join(targetAgentDir, "mcp.json"), {fsImpl});
  }
  const marker = {
    version: 1,
    kind: "mapache-vm-automation-runtime",
    runId: randomId(),
    source: "retained-disk-workspace",
  };
  await fsImpl.promises.writeFile(path.join(stateRoot, "runtime.json"), `${JSON.stringify(marker)}\n`, {mode: 0o600});
}

async function copyOptionalTree(source, destination, {fsImpl}) {
  try {
    const stat = await fsImpl.promises.lstat(source);
    if (!stat.isDirectory()) return;
    const entries = await fsImpl.promises.readdir(source, {withFileTypes: true});
    for (const entry of entries) {
      await copyEntry(path.join(source, entry.name), path.join(destination, entry.name), source, {fsImpl});
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function copyOptionalFile(source, destination, {fsImpl}) {
  try {
    await fsImpl.promises.copyFile(source, destination);
    await fsImpl.promises.chmod(destination, 0o600);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function runtimeConfig(config, {identity, outputRoot, stateRoot}) {
  const state = path.join(stateRoot);
  return {
    ...config,
    agentRuntimeEnabled: true,
    automationOutputDir: "",
    automationRunId: identity,
    homeDir: path.join(state, "home"),
    isPrivateRuntime: true,
    piAgentDir: path.join(state, "pi"),
    piMcpConfigPath: path.join(state, "pi", "mcp.json"),
    piSessionDir: path.join(state, "sessions"),
    piSessionStorageBucket: "",
    piSessionStoragePrefix: "",
    piWebUiControlPath: path.join(state, "ui", "pi-web-ui.sock"),
    piWebUiDataDir: path.join(state, "ui"),
    piWebUiPiDir: path.join(state, "pi"),
    piWebUiPort: isolatedPort(identity),
    piWebUiSessionDir: path.join(state, "sessions"),
    privateRuntimeRoot: state,
    retainedDiskMode: false,
    runtimeKind: "automation",
    runtimeProvider: "compute-engine",
    originalWorkspaceDir: config.workspaceDir,
    workspaceDir: "/workspace",
    workspaceStorageMode: "legacy",
    workspaceStorageReadyMarker: "",
    // The child writes only below this bind mount. Keep the host path out of
    // its user-facing prompt and expose the stable virtual path instead.
    vmAutomationOutputRoot: outputRoot,
  };
}

function spawnSandboxed({
  args,
  bwrapPath,
  childConfig,
  file,
  inputRoot,
  options,
  outputRoot,
  spawnImpl,
  stateRoot,
}) {
  const sandboxArgs = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--uid", "0",
    "--gid", "0",
    "--ro-bind", "/", "/",
    "--tmpfs", childConfig.originalWorkspaceDir || "/var/lib/mapache/workspace/workspace",
    "--bind", outputRoot, "/workspace",
    "--ro-bind", inputRoot, "/workspace-input",
    "--bind", path.join(stateRoot, "home"), path.join(stateRoot, "home"),
    "--bind", path.join(stateRoot, "pi"), path.join(stateRoot, "pi"),
    "--bind", path.join(stateRoot, "sessions"), path.join(stateRoot, "sessions"),
    "--bind", path.join(stateRoot, "ui"), path.join(stateRoot, "ui"),
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--chdir", "/workspace",
    "--",
    file,
    ...args,
  ];
  const env = {
    ...options.env,
    HOME: childConfig.homeDir,
    MAPACHE_HOME_DIR: childConfig.homeDir,
    PI_WEB_CWD: "/workspace",
    WORKSPACE_DIR: "/workspace",
  };
  // Node resolves the launcher cwd before bubblewrap can establish its mount
  // namespace. Use a real host path here; bubblewrap performs the virtual
  // chdir after the output bind is in place.
  return spawnImpl(bwrapPath, sandboxArgs, {...options, cwd: outputRoot, env});
}

function isolatedPort(identity) {
  const value = crypto.createHash("sha256").update(identity).digest().readUInt16BE(0);
  return 8800 + (value % 100);
}

function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  error.publicMessage = code;
  return error;
}

module.exports = {
  AUTOMATION_ROOT_NAME,
  createVmAutomationRuntimeFactory,
  copyReadonlyTree,
  isolatedPort,
  spawnSandboxed,
};
