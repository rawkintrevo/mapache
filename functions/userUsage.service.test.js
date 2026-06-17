"use strict";

const assert = require("assert");
const {
  accrueSessionUsage,
  isTerminalSessionStatus,
  parseCpuCount,
  parseMemoryGb,
  prorateUsageEntry,
  sessionUsageEntry,
} = require("./userUsage.service");

const startedAt = Date.parse("2026-06-17T10:00:00.000Z");
const stoppedAt = Date.parse("2026-06-17T10:30:00.000Z");

assert.strictEqual(parseCpuCount("2"), 2);
assert.strictEqual(parseCpuCount("bad"), 1);
assert.strictEqual(parseMemoryGb("512Mi"), 0.5);
assert.strictEqual(parseMemoryGb("2Gi"), 2);
assert.strictEqual(parseMemoryGb("1Ti"), 1024);

assert.strictEqual(isTerminalSessionStatus("stopped"), true);
assert.strictEqual(isTerminalSessionStatus("provision_failed"), true);
assert.strictEqual(isTerminalSessionStatus("running"), false);

const entry = sessionUsageEntry("session-1", {
  workspaceId: "workspace-1",
  createdAt: {toMillis: () => startedAt},
  stoppedAt: {toMillis: () => stoppedAt},
  resources: {cpu: "2", memory: "512Mi"},
});
assert.strictEqual(entry.sessionId, "session-1");
assert.strictEqual(entry.workspaceId, "workspace-1");
assert.strictEqual(entry.runtimeSeconds, 1800);
assert.strictEqual(entry.cpuSeconds, 3600);
assert.strictEqual(entry.memoryGbSeconds, 900);
assert.strictEqual(entry.startedAt.toMillis(), startedAt);
assert.strictEqual(entry.endedAt.toMillis(), stoppedAt);

const accruedAt = {
  toMillis: () => Date.parse("2026-06-17T10:10:00.000Z"),
};
assert.deepStrictEqual(accrueSessionUsage({
  runnerSessionId: "session-1",
  createdAt: {toMillis: () => startedAt},
  resources: {cpu: "1", memory: "1Gi"},
}, accruedAt), {
  usageAccruedAt: accruedAt,
  usageAccruedCpuSeconds: 600,
  usageAccruedMemoryGbSeconds: 600,
  usageAccruedRuntimeSeconds: 600,
});

const prorated = prorateUsageEntry({
  startedAt: {toMillis: () => startedAt},
  endedAt: {toMillis: () => stoppedAt},
  runtimeSeconds: 1800,
  cpuSeconds: 3600,
  memoryGbSeconds: 900,
}, Date.parse("2026-06-17T10:15:00.000Z"), Date.parse("2026-06-17T10:45:00.000Z"));
assert.strictEqual(prorated.runtimeSeconds, 900);
assert.strictEqual(prorated.cpuSeconds, 1800);
assert.strictEqual(prorated.memoryGbSeconds, 450);
assert.strictEqual(prorated.sessionCount, 1);

console.log("user usage service tests passed");
