"use strict";

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
  return env;
}

module.exports = {
  createWorkspaceProcessEnvironment,
  isolateRunnerGoogleCredentials,
};
