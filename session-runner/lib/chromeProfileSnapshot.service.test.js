"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createChromeProfileSnapshotService} = require("./chromeProfileSnapshot.service");

test("serializes periodic Chrome profile snapshots and sanitizes final state", async () => {
  let release;
  let snapshotCalls = 0;
  let sanitizeCalls = 0;
  const firstSnapshot = new Promise((resolve) => {
    release = resolve;
  });
  const profile = {
    sanitize: async () => {
      sanitizeCalls += 1;
    },
  };
  const service = createChromeProfileSnapshotService({
    config: {chromeEnabled: true},
    profile,
    snapshot: async ({final}) => {
      snapshotCalls += 1;
      assert.equal(final, false);
      await firstSnapshot;
      return "periodic-uploaded";
    },
  });

  const periodic = service.snapshot();
  const coalesced = service.snapshot();
  assert.equal(service.status().snapshotInFlight, true);
  release();
  assert.strictEqual(await periodic, await coalesced);
  assert.equal(snapshotCalls, 1);
  assert.equal(sanitizeCalls, 0);

  const final = createChromeProfileSnapshotService({
    config: {chromeEnabled: true},
    profile,
    snapshot: async ({final: isFinal}) => {
      assert.equal(isFinal, true);
      return "final-uploaded";
    },
  });
  assert.deepEqual(await final.finalize(), {
    enabled: true,
    final: true,
    result: "final-uploaded",
  });
  assert.equal(sanitizeCalls, 1);
});

test("starts an unref'd periodic snapshot timer and stops it", async () => {
  let callback;
  let cleared = null;
  const timer = {unrefCalled: false, unref() { this.unrefCalled = true; }};
  const service = createChromeProfileSnapshotService({
    config: {chromeEnabled: true, archiveSyncIntervalMs: 1234},
    profile: {sanitize: async () => {}},
    snapshot: async () => null,
    setIntervalImpl: (fn, intervalMs) => {
      callback = {fn, intervalMs};
      return timer;
    },
    clearIntervalImpl: (value) => {
      cleared = value;
    },
  });

  assert.equal(service.start().running, true);
  assert.deepEqual(callback.intervalMs, 1234);
  assert.equal(timer.unrefCalled, true);
  await callback.fn();
  await service.stop();
  assert.strictEqual(cleared, timer);
  assert.equal(service.status().running, false);
});

test("does not snapshot non-Chrome runners", async () => {
  let called = false;
  const service = createChromeProfileSnapshotService({
    config: {chromeEnabled: false},
    snapshot: async () => {
      called = true;
    },
  });

  assert.deepEqual(await service.snapshot(), {enabled: false, skipped: true});
  assert.equal(called, false);
});
