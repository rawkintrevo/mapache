"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createAgentCheckpointScheduler} = require("./agentCheckpointScheduler");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
}

function harness(overrides = {}) {
  const intervals = [];
  const timeouts = new Set();
  const events = [];
  const config = {
    agentRuntimeEnabled: false,
    archiveSyncIntervalMs: 300_000,
    manualSaveBudgetMs: 1000,
    syncIntervalMs: 30_000,
    ...overrides.config,
  };
  const scheduler = createAgentCheckpointScheduler({
    agentSnapshot: overrides.agentSnapshot || {capture: async () => ({stagingDir: ""})},
    checkpointIdentity: () => ({bootInstanceId: "boot-a"}),
    checkpointPublisher: overrides.checkpointPublisher || {},
    clearIntervalImpl: (timer) => { timer.stopped = true; },
    clearTimeoutImpl: (timer) => { clearTimeout(timer); },
    config,
    logger: {error: () => {}, warn: () => {}},
    piModelScope: overrides.piModelScope || {persist: async () => events.push("model")},
    setIntervalImpl: (callback, delay) => {
      const timer = {callback, delay, stopped: false};
      intervals.push(timer);
      return timer;
    },
    setTimeoutImpl: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      timeouts.add(timer);
      return timer;
    },
    workspaceSync: overrides.workspaceSync || {
      flush: async () => {},
      syncUp: async (options) => events.push(`workspace:${options.includeArchives}`),
    },
    ...overrides,
  });
  return {events, intervals, scheduler, timeouts};
}

test("serializes periodic and final saves and never drops the final request", async () => {
  const gate = deferred();
  const events = [];
  const {intervals, scheduler} = harness({
    workspaceSync: {
      flush: async () => {},
      syncUp: async (options) => {
        events.push(`workspace:start:${options.includeArchives}`);
        if (events.length === 1) await gate.promise;
        events.push("workspace:end");
      },
    },
  });

  scheduler.start();
  intervals[0].callback();
  const final = scheduler.finalize({timeoutMs: 500});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["workspace:start:true"]);
  gate.resolve();
  await final;
  assert.deepEqual(events, [
    "workspace:start:true",
    "workspace:end",
    "workspace:start:true",
    "workspace:end",
  ]);
});

test("debounces completed turns into one agent capture and publishes it", async () => {
  const events = [];
  let captureNumber = 0;
  const {scheduler} = harness({
    config: {agentRuntimeEnabled: true, agentCompletedTurnDebounceMs: 10},
    agentSnapshot: {capture: async () => {
      events.push("capture");
      return {stagingDir: ""};
    }},
    checkpointPublisher: {
      uploadCapture: async () => {
        events.push("upload");
        return {captureId: ++captureNumber};
      },
      commitCheckpoint: async () => events.push("commit"),
    },
    piModelScope: {persist: async () => events.push("model")},
    workspaceSync: {
      flush: async () => {},
      syncUp: async (options) => events.push(`workspace:${options.includeArchives}`),
    },
  });

  scheduler.start();
  scheduler.noteCompletedTurn();
  scheduler.noteCompletedTurn();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await scheduler.flush();

  assert.deepEqual(events, ["capture", "upload", "commit"]);
  assert.equal(scheduler.status().lastAgentSaveAt !== null, true);
  await scheduler.finalize({timeoutMs: 500});
  assert.deepEqual(events, [
    "capture", "upload", "commit",
    "model", "capture", "upload", "commit", "workspace:true",
  ]);
});

test("returns a visible bounded failure when the final save cannot finish", async () => {
  const {scheduler} = harness({
    workspaceSync: {
      flush: async () => {},
      syncUp: async () => new Promise(() => {}),
    },
  });

  await assert.rejects(() => scheduler.finalize({timeoutMs: 20}), (error) => error.code === "checkpoint_timeout");
  assert.equal(scheduler.status().lastError.code, "checkpoint_timeout");
});

test("records capture failures while preserving the previous checkpoint", async () => {
  const errors = [];
  const {scheduler} = harness({
    config: {agentRuntimeEnabled: true},
    agentSnapshot: {
      capture: async () => {
        throw Object.assign(new Error("capture failed"), {code: "snapshot_capture_failed"});
      },
    },
    checkpointPublisher: {
      recordCheckpointError: async (code) => errors.push(code),
    },
  });

  await assert.rejects(() => scheduler.finalize({timeoutMs: 500}), (error) => error.code === "snapshot_capture_failed");
  assert.deepEqual(errors, ["snapshot_capture_failed"]);
});
