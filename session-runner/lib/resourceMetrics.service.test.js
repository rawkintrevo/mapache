"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {CGROUP_FILES, createResourceMetricsService} = require("./resourceMetrics.service");

function createReader(values) {
  return async (file) => {
    if (!(file in values)) throw new Error(`missing ${file}`);
    return values[file];
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("samples cgroup values after a CPU baseline and broadcasts to subscribers", async () => {
  let usage = 0;
  let monotonicMs = 1000;
  let intervalCallback;
  const events = [];
  const readFileFn = async (file) => file === CGROUP_FILES.cpuStat ? `usage_usec ${usage}` : createReader({
    [CGROUP_FILES.cpuMax]: "200000 100000",
    [CGROUP_FILES.memoryCurrent]: "1610612736",
    [CGROUP_FILES.memoryMax]: "4294967296",
  })(file);
  const configuredService = createResourceMetricsService({
    intervalMs: 2000,
    readFileFn,
    now: () => 1700000000000,
    monotonicNow: () => monotonicMs,
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return "timer";
    },
    clearIntervalFn: () => {},
    cgroupDirectory: "/sys/fs/cgroup",
  });
  configuredService.subscribe((event) => events.push(event));
  await flush();
  assert.equal(events.length, 0);

  usage = 1000000;
  monotonicMs = 2000;
  await intervalCallback();
  await flush();

  assert.deepEqual(events, [{
    type: "metrics",
    sampledAt: 1700000000000,
    cpu: {percent: 50, limitCores: 2},
    memory: {usedBytes: 1610612736, limitBytes: 4294967296, percent: 37.5},
  }]);
  configuredService.close();
});

test("stops sampling after the final subscriber leaves and reports unavailable metrics", async () => {
  let intervalCallback;
  let clearCount = 0;
  const events = [];
  const service = createResourceMetricsService({
    readFileFn: async () => {
      throw new Error("cgroup unavailable");
    },
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return "timer";
    },
    clearIntervalFn: () => {
      clearCount += 1;
    },
    cgroupDirectory: "/sys/fs/cgroup",
  });
  const unsubscribe = service.subscribe((event) => events.push(event));
  await flush();
  assert.deepEqual(events, [{type: "metrics_unavailable", code: "resource_metrics_unavailable"}]);
  unsubscribe();
  assert.equal(clearCount, 1);
  await intervalCallback?.();
  service.close();
});
