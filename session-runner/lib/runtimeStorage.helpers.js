"use strict";

const path = require("node:path");
const fs = require("node:fs");

const SHARED_RUNTIME_STORAGE_MODE = "shared";
const PRIVATE_RUNTIME_STORAGE_MODE = "private";
const DEFAULT_PRIVATE_RUNTIME_ROOT = "/var/lib/mapache/runtimes";

function normalizeRuntimeStorageMode(value) {
  return String(value || "").trim().toLowerCase() === PRIVATE_RUNTIME_STORAGE_MODE ?
    PRIVATE_RUNTIME_STORAGE_MODE : SHARED_RUNTIME_STORAGE_MODE;
}

function isPrivateRuntimeStorageMode(value) {
  return normalizeRuntimeStorageMode(value) === PRIVATE_RUNTIME_STORAGE_MODE;
}

function normalizeRuntimeIdentity(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "session";
  const safe = normalized.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return safe.slice(0, 160) || "session";
}

function privateRuntimePaths({
  root = DEFAULT_PRIVATE_RUNTIME_ROOT,
  identity,
  runtimeRoot,
} = {}) {
  const resolvedRuntimeRoot = path.resolve(String(runtimeRoot || path.join(
      String(root || DEFAULT_PRIVATE_RUNTIME_ROOT), normalizeRuntimeIdentity(identity),
  )));
  const agentStateRoot = path.join(resolvedRuntimeRoot, "agent-state");
  const piAgentDir = path.join(agentStateRoot, "pi");
  const piSessionDir = path.join(agentStateRoot, "sessions");
  const piWebUiDataDir = path.join(agentStateRoot, "ui");
  return {
    runtimeRoot: resolvedRuntimeRoot,
    homeDir: path.join(resolvedRuntimeRoot, "home"),
    agentStateRoot,
    piAgentDir,
    piSessionDir,
    piWebUiDataDir,
    piMcpConfigPath: path.join(piAgentDir, "mcp.json"),
    piWebUiControlPath: path.join(piWebUiDataDir, "pi-web-ui.sock"),
    chromeProfileDir: path.join(resolvedRuntimeRoot, "chrome", "profile"),
    browserQaDir: path.join(resolvedRuntimeRoot, "qa"),
    privateGitDir: path.join(resolvedRuntimeRoot, "git", "repository"),
  };
}

async function ensurePrivateRuntimeDirectory(target, {fsImpl = fs} = {}) {
  const resolved = path.resolve(String(target || ""));
  if (!resolved || resolved === path.parse(resolved).root) return resolved;
  const parts = resolved.split(path.sep).filter(Boolean);
  let current = path.parse(resolved).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fsImpl.promises.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) {
      const error = new Error("private_runtime_symlink");
      error.code = "private_runtime_symlink";
      throw error;
    }
  }
  await fsImpl.promises.mkdir(resolved, {recursive: true, mode: 0o700});
  return resolved;
}

module.exports = {
  DEFAULT_PRIVATE_RUNTIME_ROOT,
  PRIVATE_RUNTIME_STORAGE_MODE,
  SHARED_RUNTIME_STORAGE_MODE,
  isPrivateRuntimeStorageMode,
  ensurePrivateRuntimeDirectory,
  normalizeRuntimeIdentity,
  normalizeRuntimeStorageMode,
  privateRuntimePaths,
};
