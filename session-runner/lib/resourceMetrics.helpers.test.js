"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calculateCpuPercent,
  calculateMemoryPercent,
  parseCpuLimitCores,
  parseCpuUsageUsec,
  parseMemoryBytes,
} = require("./resourceMetrics.helpers");

test("parses cgroup CPU and memory values", () => {
  assert.equal(parseCpuUsageUsec("usage_usec 120000\nuser_usec 90000"), 120000);
  assert.equal(parseCpuLimitCores("200000 100000"), 2);
  assert.equal(parseMemoryBytes("4294967296\n"), 4294967296);
});

test("uses available parallelism for an unlimited CPU cgroup", () => {
  assert.equal(parseCpuLimitCores("max 100000", () => 4), 4);
  assert.equal(parseCpuLimitCores("max 100000", () => 0), null);
});

test("rejects invalid and unlimited memory values", () => {
  assert.equal(parseMemoryBytes("max"), null);
  assert.equal(parseMemoryBytes("not-a-number"), null);
  assert.equal(calculateMemoryPercent(2, 0), null);
});

test("calculates CPU utilization against the container CPU limit", () => {
  assert.equal(calculateCpuPercent(
      {cpuUsageUsec: 0, monotonicMs: 1000, limitCores: 2},
      {cpuUsageUsec: 1000000, monotonicMs: 2000, limitCores: 2},
  ), 50);
  assert.equal(calculateCpuPercent(
      {cpuUsageUsec: 0, monotonicMs: 1000, limitCores: 1},
      {cpuUsageUsec: 3000000, monotonicMs: 2000, limitCores: 1},
  ), 100);
  assert.equal(calculateMemoryPercent(3, 4), 75);
});
