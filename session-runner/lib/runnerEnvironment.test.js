"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createWorkspaceProcessEnvironment,
  isolateRunnerGoogleCredentials,
} = require("./runnerEnvironment");

test("runner control plane ignores workspace Google credentials", () => {
  const env = {
    FIREBASE_PROJECT_ID: "test-project",
    GOOGLE_APPLICATION_CREDENTIALS: "/workspace/.gcloud/account.json",
  };

  const isolated = isolateRunnerGoogleCredentials(env);

  assert.deepEqual(isolated, {
    workspaceGoogleApplicationCredentials: "/workspace/.gcloud/account.json",
  });
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.FIREBASE_PROJECT_ID, "test-project");
});

test("workspace child environment receives the preserved credential path", () => {
  const baseEnv = {FIREBASE_PROJECT_ID: "test-project"};
  const childEnv = createWorkspaceProcessEnvironment({
    workspaceGoogleApplicationCredentials: "/workspace/.gcloud/account.json",
  }, baseEnv);

  assert.equal(childEnv.GOOGLE_APPLICATION_CREDENTIALS, "/workspace/.gcloud/account.json");
  assert.equal(baseEnv.GOOGLE_APPLICATION_CREDENTIALS, undefined);
});
