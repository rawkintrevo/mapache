"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createRunnerLifecycleCoordinator} = require("./runnerLifecycle");

function createLifecycleHarness(events, overrides = {}) {
  const config = {
    archiveSyncIntervalMs: 60_000,
    port: 9222,
    syncIntervalMs: 60_000,
    workspaceSourceMode: "blank",
    workspaceSyncPolicyMode: "archive",
    ...overrides.config,
  };
  const service = (method, event) => ({
    [method]: async () => events.push(event),
  });

  return createRunnerLifecycleCoordinator({
    activity: overrides.activity || {updateSessionActivity: async () => events.push("activity.updateSessionActivity")},
    activeHarness: overrides.activeHarness || {
      materializeAuth: async () => events.push("activeHarness.materializeAuth"),
      materializeConfig: async () => events.push("activeHarness.materializeConfig"),
      materializeMcp: async () => events.push("activeHarness.materializeMcp"),
      materializeSkills: async () => events.push("activeHarness.materializeSkills"),
      materializeSubagents: async () => events.push("activeHarness.materializeSubagents"),
    },
    admin: overrides.admin || {firestore: {FieldValue: {serverTimestamp: () => "timestamp"}}},
    chromeProfile: overrides.chromeProfile || service("restore", "chromeProfile.restore"),
    chromeProfileSnapshots: overrides.chromeProfileSnapshots || {
      enabled: () => true,
      finalize: async () => events.push("chromeProfileSnapshots.finalize"),
      start: () => events.push("chromeProfileSnapshots.start"),
      stop: async () => events.push("chromeProfileSnapshots.stop"),
    },
    chromeRuntime: overrides.chromeRuntime || {
      start: async () => events.push("chromeRuntime.start"),
      stop: async () => events.push("chromeRuntime.stop"),
    },
    config,
    git: overrides.git || service("prepareGithubAutomationBranch", "git.prepareGithubAutomationBranch"),
    listen: overrides.listen || (() => events.push("server.listen")),
    logger: overrides.logger || {error: () => {}, log: () => {}},
    piModelScope: overrides.piModelScope || {
      persist: async () => events.push("piModelScope.persist"),
      restore: async () => events.push("piModelScope.restore"),
    },
    setIntervalFn: overrides.setIntervalFn || (() => {
      events.push("syncLoop.start");
      return {unref: () => {}};
    }),
    sshSession: overrides.sshSession || {closeAll: () => events.push("sshSession.closeAll")},
    workspace: overrides.workspace || {
      ensureWorkspace: async () => events.push("workspace.ensureWorkspace"),
      prepareWorkspaceSource: async () => events.push("workspace.prepareWorkspaceSource"),
    },
    workspaceSync: overrides.workspaceSync || {syncUp: async () => events.push("workspaceSync.syncUp")},
  });
}

test("startup runs ordered preparation before snapshots, sync, and listen", async () => {
  const events = [];
  const lifecycle = createLifecycleHarness(events);

  await lifecycle.start();

  assert.deepEqual(events, [
    "workspace.ensureWorkspace",
    "workspace.prepareWorkspaceSource",
    "piModelScope.restore",
    "chromeProfile.restore",
    "chromeRuntime.start",
    "activeHarness.materializeConfig",
    "activeHarness.materializeAuth",
    "git.prepareGithubAutomationBranch",
    "activeHarness.materializeMcp",
    "activeHarness.materializeSkills",
    "activeHarness.materializeSubagents",
    "chromeProfileSnapshots.start",
    "syncLoop.start",
    "server.listen",
  ]);
});

test("startup failure prevents later lifecycle steps and listen", async () => {
  const events = [];
  const lifecycle = createLifecycleHarness(events, {
    workspace: {
      ensureWorkspace: async () => events.push("workspace.ensureWorkspace"),
      prepareWorkspaceSource: async () => {
        events.push("workspace.prepareWorkspaceSource");
        throw new Error("prepare failed");
      },
    },
  });

  await assert.rejects(() => lifecycle.start(), /prepare failed/);
  assert.deepEqual(events, ["workspace.ensureWorkspace", "workspace.prepareWorkspaceSource"]);
});

test("shutdown closes forwards before final profile snapshot and activity update", async () => {
  const events = [];
  const lifecycle = createLifecycleHarness(events);

  await lifecycle.shutdown();

  assert.deepEqual(events, [
    "sshSession.closeAll",
    "chromeRuntime.stop",
    "piModelScope.persist",
    "chromeProfileSnapshots.stop",
    "chromeProfileSnapshots.finalize",
    "activity.updateSessionActivity",
  ]);
});

test("shutdown syncs archives directly for non-Chrome runners", async () => {
  const events = [];
  const lifecycle = createLifecycleHarness(events, {
    chromeProfileSnapshots: {
      enabled: () => false,
      finalize: async () => events.push("chromeProfileSnapshots.finalize"),
      start: () => events.push("chromeProfileSnapshots.start"),
      stop: async () => events.push("chromeProfileSnapshots.stop"),
    },
  });

  await lifecycle.shutdown();

  assert.deepEqual(events, [
    "sshSession.closeAll",
    "chromeRuntime.stop",
    "piModelScope.persist",
    "workspaceSync.syncUp",
    "activity.updateSessionActivity",
  ]);
});
