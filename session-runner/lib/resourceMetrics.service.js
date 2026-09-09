"use strict";

const fs = require("fs");
const path = require("path");
const {promisify} = require("util");
const {
  calculateCpuPercent,
  calculateMemoryPercent,
  parseCpuLimitCores,
  parseCpuLimitCoresV1,
  parseCpuUsageNsec,
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
const CGROUP_V1_FILES = Object.freeze({
  cpuUsage: path.join(CGROUP_ROOT, "cpu,cpuacct", "cpuacct.usage"),
  cpuQuota: path.join(CGROUP_ROOT, "cpu,cpuacct", "cpu.cfs_quota_us"),
  cpuPeriod: path.join(CGROUP_ROOT, "cpu,cpuacct", "cpu.cfs_period_us"),
  memoryUsed: path.join(CGROUP_ROOT, "memory", "memory.usage_in_bytes"),
  memoryLimit: path.join(CGROUP_ROOT, "memory", "memory.limit_in_bytes"),
});
const CGROUP_V1_SERVICE_FILES = Object.freeze({
  cpuUsage: path.join(CGROUP_ROOT, "cpuacct", "cpuacct.usage"),
  cpuQuota: path.join(CGROUP_ROOT, "cpu", "cpu.cfs_quota_us"),
  cpuPeriod: path.join(CGROUP_ROOT, "cpu", "cpu.cfs_period_us"),
  memoryUsed: path.join(CGROUP_ROOT, "memory", "memory.usage_in_bytes"),
  memoryLimit: path.join(CGROUP_ROOT, "memory", "memory.limit_in_bytes"),
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
  let resolvedCgroup = cgroupDirectory ? {version: 2, directory: cgroupDirectory} : null;
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
    if (resolvedCgroup?.version === 2) return readV2Snapshot(resolvedCgroup.directory);
    if (resolvedCgroup?.version === 1) return readV1Snapshot(resolvedCgroup.files);

    const paths = await resolveCgroupPaths();
    try {
      const snapshot = await readV2Snapshot(paths.v2Directory);
      resolvedCgroup = {version: 2, directory: paths.v2Directory};
      return snapshot;
    } catch (v2Error) {
      let lastError = v2Error;
      for (const files of paths.v1Candidates) {
        try {
          const snapshot = await readV1Snapshot(files);
          resolvedCgroup = {version: 1, files};
          return snapshot;
        } catch (v1Error) {
          lastError = v1Error;
        }
      }
      throw new Error("cgroup_metrics_unavailable", {cause: lastError});
    }
  }

  async function readV2Snapshot(directory) {
    const files = cgroupFiles(directory);
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
    return validateSnapshot({
      cpuUsageUsec,
      limitCores,
      memoryUsedBytes,
      memoryLimitBytes,
      monotonicMs: monotonicNow(),
    });
  }

  async function readV1Snapshot(files) {
    const [cpuUsage, cpuQuota, cpuPeriod, memoryUsed, memoryLimit] = await Promise.all([
      readFileFn(files.cpuUsage, "utf8"),
      readFileFn(files.cpuQuota, "utf8"),
      readFileFn(files.cpuPeriod, "utf8"),
      readFileFn(files.memoryUsed, "utf8"),
      readFileFn(files.memoryLimit, "utf8"),
    ]);
    return validateSnapshot({
      cpuUsageUsec: parseCpuUsageNsec(cpuUsage),
      limitCores: parseCpuLimitCoresV1(cpuQuota, cpuPeriod),
      memoryUsedBytes: parseMemoryBytes(memoryUsed),
      memoryLimitBytes: parseMemoryBytes(memoryLimit),
      monotonicMs: monotonicNow(),
    });
  }

  async function resolveCgroupPaths() {
    const contents = await readFileFn(CGROUP_SELF_PATH, "utf8");
    const lines = String(contents || "").split(/\r?\n/);
    const unifiedLine = lines.find((entry) => entry.startsWith("0::"));
    const unifiedPath = unifiedLine ? unifiedLine.slice(3).trim() : "";
    const cpuControllerPath = controllerPath(lines, "cpu");
    const cpuPath = controllerPath(lines, "cpuacct");
    const memoryPath = controllerPath(lines, "memory");
    const combinedRoot = path.join(CGROUP_ROOT, "cpu,cpuacct");
    const cpuRoot = path.join(CGROUP_ROOT, "cpu");
    const cpuAccountingRoot = path.join(CGROUP_ROOT, "cpuacct");
    const memoryRoot = path.join(CGROUP_ROOT, "memory");
    return {
      v2Directory: resolveCgroupPath(CGROUP_ROOT, unifiedPath),
      v1Candidates: uniqueFileSets([
        cgroupV1Files(
            resolveCgroupPath(combinedRoot, cpuPath),
            resolveCgroupPath(combinedRoot, cpuPath),
            resolveCgroupPath(memoryRoot, memoryPath),
        ),
        cgroupV1Files(
            resolveCgroupPath(cpuRoot, cpuControllerPath),
            resolveCgroupPath(cpuAccountingRoot, cpuPath),
            resolveCgroupPath(memoryRoot, memoryPath),
        ),
        cgroupV1Files(combinedRoot, combinedRoot, memoryRoot),
        cgroupV1Files(cpuRoot, cpuAccountingRoot, memoryRoot),
      ]),
    };
  }

  function broadcast(event) {
    for (const listener of listeners) listener(event);
  }

  function publishUnavailable() {
    unavailable = true;
    broadcast({type: "metrics_unavailable", code: "resource_metrics_unavailable"});
  }
}

function validateSnapshot(snapshot) {
  if (snapshot.cpuUsageUsec === null || snapshot.limitCores === null ||
    snapshot.memoryUsedBytes === null || snapshot.memoryLimitBytes === null) {
    throw new Error("cgroup_metrics_unavailable");
  }
  return snapshot;
}

function controllerPath(lines, controller) {
  const line = lines.find((entry) => {
    const parts = entry.split(":");
    return parts.length === 3 && parts[1].split(",").includes(controller);
  });
  return line ? line.split(":")[2].trim() : "";
}

function resolveCgroupPath(root, relativePath) {
  if (!relativePath || relativePath.includes("..")) return root;
  return path.resolve(root, `.${relativePath}`);
}

function uniqueFileSets(fileSets) {
  const seen = new Set();
  return fileSets.filter((files) => {
    const key = JSON.stringify(files);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function cgroupV1Files(cpuDirectory, cpuAccountingDirectory, memoryDirectory) {
  return {
    cpuUsage: path.join(cpuAccountingDirectory, "cpuacct.usage"),
    cpuQuota: path.join(cpuDirectory, "cpu.cfs_quota_us"),
    cpuPeriod: path.join(cpuDirectory, "cpu.cfs_period_us"),
    memoryUsed: path.join(memoryDirectory, "memory.usage_in_bytes"),
    memoryLimit: path.join(memoryDirectory, "memory.limit_in_bytes"),
  };
}

module.exports = {
  CGROUP_FILES,
  CGROUP_ROOT,
  CGROUP_V1_FILES,
  CGROUP_V1_SERVICE_FILES,
  cgroupFiles,
  cgroupV1Files,
  createResourceMetricsService,
};
