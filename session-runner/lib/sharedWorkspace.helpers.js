"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {SHARED_WORKSPACE_READY_MARKER} = require("./runtimePaths");

const SHARED_WORKSPACE_STORAGE_MODE = "shared-gcsfuse-v1";

function isSharedGcsFuseMode(value) {
  return String(value || "").trim().toLowerCase() === SHARED_WORKSPACE_STORAGE_MODE;
}

function sharedWorkspaceError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function markerPathFor(workspaceDir, marker) {
  const relative = String(marker || SHARED_WORKSPACE_READY_MARKER).trim().replace(/^\/+/, "");
  if (!relative || relative.split("/").includes("..")) {
    throw sharedWorkspaceError("shared_workspace_marker_invalid", "Shared workspace ready marker must be relative to the workspace mount");
  }
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, ...relative.split("/"));
  const relativeTarget = path.relative(root, target);
  if (relativeTarget.startsWith(`..${path.sep}`) || relativeTarget === ".." || path.isAbsolute(relativeTarget)) {
    throw sharedWorkspaceError("shared_workspace_marker_invalid", "Shared workspace ready marker must stay inside the workspace mount");
  }
  return target;
}

function assertPathOutsideWorkspace(workspaceDir, target, label) {
  if (!target) return;
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw sharedWorkspaceError(
        "shared_workspace_private_path_invalid",
        `${label || "Private runtime path"} must resolve outside the shared workspace mount`,
    );
  }
}

async function assertSharedWorkspaceMount(config = {}, {fsImpl = fs} = {}) {
  if (!isSharedGcsFuseMode(config.workspaceStorageMode)) return {ok: true, skipped: true};
  const workspaceDir = path.resolve(config.workspaceDir || "/workspace");
  const generation = String(config.workspaceStorageGeneration || "").trim();
  if (!generation) {
    throw sharedWorkspaceError("shared_workspace_generation_missing", "Shared workspace storage generation is not configured");
  }

  let stat;
  try {
    stat = await fsImpl.promises.stat(workspaceDir);
  } catch (error) {
    throw sharedWorkspaceError("shared_workspace_mount_missing", "Shared workspace mount is unavailable", error);
  }
  if (!stat.isDirectory()) {
    throw sharedWorkspaceError("shared_workspace_mount_invalid", "Shared workspace mount is not a directory");
  }

  const markerPath = markerPathFor(workspaceDir, config.workspaceStorageReadyMarker);
  let marker;
  try {
    marker = JSON.parse(await fsImpl.promises.readFile(markerPath, "utf8"));
  } catch (error) {
    throw sharedWorkspaceError("shared_workspace_ready_marker_missing", "Shared workspace generation-ready marker is unavailable", error);
  }
  if (!marker || marker.state !== "ready" || String(marker.storageGeneration || "") !== generation) {
    throw sharedWorkspaceError("shared_workspace_ready_marker_mismatch", "Shared workspace generation-ready marker does not match the trusted generation");
  }

  const probe = path.join(path.dirname(markerPath), `.write-probe-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fsImpl.promises.writeFile(probe, "mapache shared workspace write probe\n", {flag: "wx"});
    await fsImpl.promises.unlink(probe);
  } catch (error) {
    await fsImpl.promises.unlink(probe).catch(() => {});
    throw sharedWorkspaceError("shared_workspace_mount_read_only", "Shared workspace mount is not writable", error);
  }

  for (const [label, target] of Object.entries({
    "Private runtime root": config.privateRuntimeRoot,
    "Private Git directory": config.privateGitDir,
    "Agent state directory": config.agentStateRoot,
    "Pi agent directory": config.piAgentDir,
    "Pi session directory": config.piSessionDir,
    "Pi Web UI data directory": config.piWebUiDataDir,
    "Chrome profile directory": config.chromeProfileDir,
    "Browser QA directory": config.browserQaDir,
    "Pi MCP config": config.piMcpConfigPath,
  })) {
    assertPathOutsideWorkspace(workspaceDir, target, label);
  }
  return {ok: true, markerPath, storageGeneration: generation};
}

module.exports = {
  SHARED_WORKSPACE_STORAGE_MODE,
  assertPathOutsideWorkspace,
  assertSharedWorkspaceMount,
  isSharedGcsFuseMode,
  markerPathFor,
};
