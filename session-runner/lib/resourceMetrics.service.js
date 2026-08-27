"use strict";

const fs = require("fs");
const path = require("path");
const {promisify} = require("util");
const {
  calculateCpuPercent,
  calculateMemoryPercent,
  parseCpuLimitCores,
  parseCpuUsageUsec,
  parseMemoryBytes,
} = require("./resourceMetrics.helpers");

const readFile = promisify(fs.readFile);
const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP_SELF_PATH = "/proc/self/cgroup";
const CGROUP_FILES = Object.freeze({
  cpuStat: path.join(CGROUP_ROOT, "cpu.stat"),
  cpuMax: path.join(CGROUP_ROOT, "cpu.max"),
  memoryCurrent: path.join(CGROUP_ROOT, "memory.current"),
  memoryMax: path.join(CGROUP_ROOT, "memory.max"),
});

function createResourceMetricsService({
  intervalMs = 2000,
  readFileFn = readFile,
  now = Date.now,
  monotonicNow = () => Number(process.hrtime.bigint() / 1000000n),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
  cgroupDirectory = null,
} = {}) {
  const listeners = new Set();
  let timer = null;
  let previous = null;
  let resolvedCgroupDirectory = cgroupDirectory;
  let unavailable = false;

  return {
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stop();
      };
    },
    close: stop,
  };

  function start() {
    if (timer) return;
    previous = null;
    unavailable = false;
    void sample();
    timer = setIntervalFn(() => void sample(), intervalMs);
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
    previous = null;
    unavailable = false;
    listeners.clear();
  }

  async function sample() {
    if (!listeners.size) return;
    try {
      const current = await readSnapshot();
      const cpuPercent = calculateCpuPercent(previous, current);
      previous = current;
      if (cpuPercent === null) return;
      const memoryPercent = calculateMemoryPercent(current.memoryUsedBytes, current.memoryLimitBytes);
      if (memoryPercent === null) {
        publishUnavailable();
        return;
      }
      unavailable = false;
      broadcast({
        type: "metrics",
        sampledAt: now(),
        cpu: {
          percent: round(cpuPercent),
          limitCores: current.limitCores,
        },
        memory: {
          usedBytes: current.memoryUsedBytes,
          limitBytes: current.memoryLimitBytes,
          percent: round(memoryPercent),
        },
      });
    } catch (error) {
      if (!unavailable) {
        logger.warn?.("resource metrics collection failed", error && error.message ? error.message : error);
        publishUnavailable();
      }
    }
  }

  async function readSnapshot() {
    if (!resolvedCgroupDirectory) resolvedCgroupDirectory = await resolveCgroupDirectory();
    const files = cgroupFiles(resolvedCgroupDirectory);
    const [cpuStat, cpuMax, memoryCurrent, memoryMax] = await Promise.all([
      readFileFn(files.cpuStat, "utf8"),
      readFileFn(files.cpuMax, "utf8"),
      readFileFn(files.memoryCurrent, "utf8"),
      readFileFn(files.memoryMax, "utf8"),
    ]);
    const cpuUsageUsec = parseCpuUsageUsec(cpuStat);
    const limitCores = parseCpuLimitCores(cpuMax);
    const memoryUsedBytes = parseMemoryBytes(memoryCurrent);
    const memoryLimitBytes = parseMemoryBytes(memoryMax);
    if (cpuUsageUsec === null || limitCores === null || memoryUsedBytes === null || memoryLimitBytes === null) {
      throw new Error("cgroup_metrics_unavailable");
    }
    return {
      cpuUsageUsec,
      limitCores,
      memoryUsedBytes,
      memoryLimitBytes,
      monotonicMs: monotonicNow(),
    };
  }

  async function resolveCgroupDirectory() {
    const contents = await readFileFn(CGROUP_SELF_PATH, "utf8");
    const line = String(contents || "").split(/\r?\n/).find((entry) => entry.startsWith("0::"));
    const relativePath = line ? line.slice(3).trim() : "";
    if (!relativePath || relativePath.includes("..")) return CGROUP_ROOT;
    return path.resolve(CGROUP_ROOT, `.${relativePath}`);
  }

  function broadcast(event) {
    for (const listener of listeners) listener(event);
  }

  function publishUnavailable() {
    unavailable = true;
    broadcast({type: "metrics_unavailable", code: "resource_metrics_unavailable"});
  }
}

function round(value) {
  return Number(value.toFixed(1));
}

function cgroupFiles(directory) {
  return {
    cpuStat: path.join(directory, "cpu.stat"),
    cpuMax: path.join(directory, "cpu.max"),
    memoryCurrent: path.join(directory, "memory.current"),
    memoryMax: path.join(directory, "memory.max"),
  };
}

module.exports = {
  CGROUP_FILES,
  CGROUP_ROOT,
  cgroupFiles,
  createResourceMetricsService,
};
