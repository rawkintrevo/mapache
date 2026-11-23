"use strict";

const path = require("node:path");

const DEFAULT_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function isolateRunnerGoogleCredentials(env = process.env) {
  const workspaceGoogleApplicationCredentials = String(
      env.GOOGLE_APPLICATION_CREDENTIALS || "",
  ).trim();
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  return {workspaceGoogleApplicationCredentials};
}

function createWorkspaceProcessEnvironment(config, baseEnv = process.env) {
  const env = {...baseEnv};
  applyMapacheToolPath(config, env);
  const credentialsPath = String(config.workspaceGoogleApplicationCredentials || "").trim();
  if (credentialsPath) env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  else delete env.GOOGLE_APPLICATION_CREDENTIALS;
  if (config?.isPrivateRuntime) {
    const privateRuntimeRoot = config.privateRuntimeRoot || path.dirname(config.homeDir);
    env.HOME = config.homeDir;
    env.MAPACHE_HOME_DIR = config.homeDir;
    env.XDG_CONFIG_HOME = path.join(config.homeDir, ".config");
    env.XDG_CACHE_HOME = path.join(privateRuntimeRoot, "cache");
    env.XDG_STATE_HOME = path.join(privateRuntimeRoot, "state");
    env.TMPDIR = path.join(privateRuntimeRoot, "tmp");
  }
  if (config?.retainedDiskMode) {
    env.HOME = config.homeDir;
    env.MAPACHE_HOME_DIR = config.homeDir;
    env.XDG_CONFIG_HOME = path.join(config.homeDir, ".config");
    env.XDG_CACHE_HOME = config.retainedDiskPaths.caches;
    env.XDG_STATE_HOME = path.join(config.homeDir, ".local", "state");
    // Locks/sockets and temporary files belong to the current container.
    env.TMPDIR = "/tmp";
  }
  if (config?.workspaceStorageMode === "shared-gcsfuse-v1" && config.privateGitDir) {
    env.GIT_DIR = config.privateGitDir;
    env.GIT_WORK_TREE = config.workspaceDir;
  }
  return env;
}

function applyMapacheToolPath(config = {}, env = process.env) {
  const workspaceBinDir = config.workspaceLocalBinDir ||
    path.join(config.workspaceDir || "/workspace", ".local", "bin");
  const userBinDir = config.userLocalBinDir || "/root/.local/bin";
  env.PATH = prependPathEntries(env.PATH, [workspaceBinDir, userBinDir]);
  env.MAPACHE_WORKSPACE_BIN_DIR = workspaceBinDir;
  env.MAPACHE_USER_BIN_DIR = userBinDir;
  return env;
}

function prependPathEntries(existingPath, entries) {
  const result = [];
  for (const value of [...entries, ...(String(existingPath || DEFAULT_SYSTEM_PATH).split(":"))]) {
    const entry = String(value || "").trim();
    if (!entry || result.includes(entry)) continue;
    result.push(entry);
  }
  return result.join(":");
}

module.exports = {
  applyMapacheToolPath,
  createWorkspaceProcessEnvironment,
  isolateRunnerGoogleCredentials,
  prependPathEntries,
};
