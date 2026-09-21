"use strict";

const path = require("node:path");

function isolateRunnerGoogleCredentials(env = process.env) {
  const workspaceGoogleApplicationCredentials = String(
      env.GOOGLE_APPLICATION_CREDENTIALS || "",
  ).trim();
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  return {workspaceGoogleApplicationCredentials};
}

function createWorkspaceProcessEnvironment(config, baseEnv = process.env) {
  const env = {...baseEnv};
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
  if (config?.workspaceStorageMode === "shared-gcsfuse-v1" && config.privateGitDir) {
    env.GIT_DIR = config.privateGitDir;
    env.GIT_WORK_TREE = config.workspaceDir;
  }
  return env;
}

module.exports = {
  createWorkspaceProcessEnvironment,
  isolateRunnerGoogleCredentials,
};
