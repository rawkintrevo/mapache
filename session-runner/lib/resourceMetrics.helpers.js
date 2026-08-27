"use strict";

const os = require("os");

function parseCpuUsageUsec(value) {
  const match = String(value || "").match(/(?:^|\n)usage_usec\s+(\d+)/);
  if (!match) return null;
  const usage = Number(match[1]);
  return Number.isFinite(usage) && usage >= 0 ? usage : null;
}

function parseCpuLimitCores(value, availableParallelism = os.availableParallelism) {
  const [quota, period] = String(value || "").trim().split(/\s+/);
  if (quota === "max") {
    const fallback = Number(availableParallelism());
    return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
  }
  const quotaUsec = Number(quota);
  const periodUsec = Number(period);
  if (!Number.isFinite(quotaUsec) || !Number.isFinite(periodUsec) || quotaUsec <= 0 || periodUsec <= 0) return null;
  return quotaUsec / periodUsec;
}

function parseMemoryBytes(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized === "max") return null;
  const bytes = Number(normalized);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

function calculateCpuPercent(previous, current) {
  if (!previous || !current || !Number.isFinite(current.cpuUsageUsec) || !Number.isFinite(previous.cpuUsageUsec) ||
    !Number.isFinite(current.monotonicMs) || !Number.isFinite(previous.monotonicMs) ||
    !Number.isFinite(current.limitCores) || current.limitCores <= 0) return null;
  const elapsedMs = current.monotonicMs - previous.monotonicMs;
  const usageUsec = current.cpuUsageUsec - previous.cpuUsageUsec;
  if (elapsedMs <= 0 || usageUsec < 0) return null;
  return clampPercent((usageUsec / (elapsedMs * 1000 * current.limitCores)) * 100);
}

function calculateMemoryPercent(usedBytes, limitBytes) {
  if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || usedBytes < 0 || limitBytes <= 0) return null;
  return clampPercent((usedBytes / limitBytes) * 100);
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

module.exports = {
  calculateCpuPercent,
  calculateMemoryPercent,
  clampPercent,
  parseCpuLimitCores,
  parseCpuUsageUsec,
  parseMemoryBytes,
};
