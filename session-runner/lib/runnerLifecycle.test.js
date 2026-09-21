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
    activity: overrides.activity || {
      markRuntimeStartupFailure: async () => events.push("activity.markRuntimeStartupFailure"),
      updateSessionActivity: async () => events.push("activity.updateSessionActivity"),
    },
    activeHarness: overrides.activeHarness || {
      materializeAuth: async () => events.push("activeHarness.materializeAuth"),
      materializeConfig: async () => events.push("activeHarness.materializeConfig"),
      materializeMcp: async () => events.push("activeHarness.materializeMcp"),
      materializeSkills: async () => events.push("activeHarness.materializeSkills"),
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
    checkpointScheduler: overrides.checkpointScheduler,
    automationExecution: overrides.automationExecution,
    config,
    git: overrides.git || service("prepareGithubAutomationBranch", "git.prepareGithubAutomationBranch"),
    listen: overrides.listen || (() => events.push("server.listen")),
    logger: overrides.logger || {error: () => {}, log: () => {}},
    piWebUi: overrides.piWebUi,
    resourceMetrics: overrides.resourceMetrics,
    piModelScope: overrides.piModelScope || {
      persist: async () => events.push("piModelScope.persist"),
      restore: async () => events.push("piModelScope.restore"),
    },
    setIntervalFn: overrides.setIntervalFn || (() => {
      events.push("syncLoop.start");
      return {unref: () => {}};
    }),
    workspace: overrides.workspace || {
      ensureWorkspace: async () => events.push("workspace.ensureWorkspace"),
      prepareWorkspaceSource: async () => events.push("workspace.prepareWorkspaceSource"),
    },
    workspaceAuthority: overrides.workspaceAuthority,
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
    "activity.updateSessionActivity",
    "piModelScope.restore",
    "chromeProfile.restore",
    "chromeRuntime.start",
    "activeHarness.materializeConfig",
    "activeHarness.materializeAuth",
    "git.prepareGithubAutomationBranch",
    "activeHarness.materializeMcp",
    "activeHarness.materializeSkills",
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
  assert.deepEqual(events, [
    "workspace.ensureWorkspace",
    "workspace.prepareWorkspaceSource",
    "activity.markRuntimeStartupFailure",
  ]);
});

test("managed startup launches pi-web-ui after materialization and stops it first", async () => {
  const events = [];
  const lifecycle = createLifecycleHarness(events, {
    config: {agentRuntimeEnabled: true},
    piWebUi: {
      start: async () => events.push("piWebUi.start"),
      quiesce: async () => events.push("piWebUi.quiesce"),
      stop: async () => events.push("piWebUi.stop"),
    },
    workspaceAuthority: {
      acquire: async () => events.push("workspaceAuthority.acquire"),
      isCurrentWriter: () => true,
      release: async (reason) => events.push(`workspaceAuthority.release:${reason}`),
    },
    workspace: {
      ensureWorkspace: async () => events.push("workspace.ensureWorkspace"),
      prepareWorkspaceSource: async () => events.push("workspace.prepareWorkspaceSource"),
      restoreCheckpoint: async () => events.push("workspace.restoreCheckpoint"),
    },
  });

  await lifecycle.start();
  assert.equal(events.indexOf("workspace.restoreCheckpoint") < events.indexOf("workspaceAuthority.acquire"), true);
  assert.equal(events.indexOf("workspaceAuthority.acquire") < events.indexOf("activeHarness.materializeConfig"), true);
  assert.equal(events.indexOf("piWebUi.start") > events.indexOf("activeHarness.materializeSkills"), true);
  assert.equal(events.indexOf("piWebUi.start") < events.indexOf("chromeProfileSnapshots.start"), true);
  await lifecycle.shutdown();
  assert.equal(events.indexOf("piWebUi.quiesce") < events.indexOf("piWebUi.stop"), true);
  assert.equal(events.at(-1), "workspaceAuthority.release:shutdown");
});

test("automation execution starts only after Pi admission and stops before upstream quiesce", async () => {
  const events = [];
  const lifecycle = createLifecycleHarness(events, {
    config: {agentRuntimeEnabled: true, runtimeKind: "automation"},
    automationExecution: {
      start: async () => events.push("automationExecution.start"),
      stop: () => events.push("automationExecution.stop"),
    },
    piWebUi: {
      start: async () => events.push("piWebUi.start"),
      quiesce: async () => events.push("piWebUi.quiesce"),
      stop: async () => events.push("piWebUi.stop"),
    },
  });

  await lifecycle.start();
  assert.equal(events.indexOf("piWebUi.start") < events.indexOf("automationExecution.start"), true);
  await lifecycle.shutdown();
  assert.equal(events.indexOf("automationExecution.stop") < events.indexOf("piWebUi.quiesce"), true);
});

test("managed shutdown escalates after cooperative quiesce fails", async () => {
  const events = [];
  const lifecycle = createLifecycleHarness(events, {
    config: {agentRuntimeEnabled: true},
    logger: {error: () => {}, log: () => {}, warn: () => events.push("logger.warn")},
    piWebUi: {
      quiesce: async () => {
        events.push("piWebUi.quiesce");
        throw new Error("pi_web_ui_quiesce_timeout");
      },
      stop: async () => events.push("piWebUi.stop"),
    },
  });

  await lifecycle.shutdown();

  assert.deepEqual(events.slice(0, 3), ["piWebUi.quiesce", "logger.warn", "piWebUi.stop"]);
});

test("managed shutdown finalizes the checkpoint scheduler after writers stop", async () => {
  const events = [];
  const lifecycle = createLifecycleHarness(events, {
    checkpointScheduler: {
      start: () => events.push("checkpointScheduler.start"),
      stop: () => events.push("checkpointScheduler.stop"),
      finalize: async () => events.push("checkpointScheduler.finalize"),
    },
    chromeProfileSnapshots: {
      enabled: () => false,
      finalize: async () => events.push("chromeProfileSnapshots.finalize"),
      start: () => events.push("chromeProfileSnapshots.start"),
      stop: async () => events.push("chromeProfileSnapshots.stop"),
    },
    config: {agentRuntimeEnabled: true},
    piWebUi: {
      start: async () => events.push("piWebUi.start"),
      quiesce: async () => events.push("piWebUi.quiesce"),
      stop: async () => events.push("piWebUi.stop"),
    },
  });

  await lifecycle.start();
  await lifecycle.shutdown();

  assert.equal(events.indexOf("checkpointScheduler.start") < events.indexOf("server.listen"), true);
  assert.equal(events.indexOf("checkpointScheduler.stop") < events.indexOf("piWebUi.quiesce"), true);
  assert.equal(events.indexOf("piWebUi.stop") < events.indexOf("checkpointScheduler.finalize"), true);
  assert.equal(events.indexOf("checkpointScheduler.finalize") < events.lastIndexOf("activity.updateSessionActivity"), true);
});

test("checkpoint failure prevents shutdown acknowledgement", async () => {
  const events = [];
  const lifecycle = createLifecycleHarness(events, {
    checkpointScheduler: {
      start: () => {},
      stop: () => events.push("checkpointScheduler.stop"),
      finalize: async () => {
        events.push("checkpointScheduler.finalize");
        throw Object.assign(new Error("checkpoint storage failed"), {code: "checkpoint_storage_failed"});
      },
    },
    chromeProfileSnapshots: {
      enabled: () => false,
      finalize: async () => {},
      start: () => {},
      stop: async () => {},
    },
  });

  await assert.rejects(() => lifecycle.shutdown(), (error) => error.code === "checkpoint_storage_failed");
  assert.equal(events.includes("activity.updateSessionActivity"), false);
});

test("shutdown closes runtime resources before final profile snapshot and activity update", async () => {
  const events = [];
  const lifecycle = createLifecycleHarness(events, {
    resourceMetrics: {close: () => events.push("resourceMetrics.close")},
  });

  await lifecycle.shutdown();

  assert.deepEqual(events, [
    "resourceMetrics.close",
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
    "chromeRuntime.stop",
    "piModelScope.persist",
    "workspaceSync.syncUp",
    "activity.updateSessionActivity",
  ]);
});
