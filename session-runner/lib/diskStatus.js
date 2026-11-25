"use strict";

const fs = require("node:fs");

function createDiskStatusService({root, storageMode = "unknown", now = () => new Date().toISOString(), statfs} = {}) {
  const diskRoot = String(root || "").trim();
  const readStats = statfs || ((target) => fs.promises.statfs(target, {bigint: true}));

  async function status() {
    const measuredAt = now();
    if (!diskRoot) return unknownStatus(measuredAt);
    try {
      const stats = await readStats(diskRoot);
      const blockSize = safeInteger(stats.bsize);
      const blocks = safeInteger(stats.blocks);
      const freeBlocks = safeInteger(stats.bfree);
      const availableBlocks = safeInteger(stats.bavail);
      if (![blockSize, blocks, freeBlocks, availableBlocks].every(Number.isSafeInteger) ||
          blockSize <= 0 || blocks < 0 || freeBlocks < 0 || availableBlocks < 0 ||
          freeBlocks > blocks || availableBlocks > blocks) return unknownStatus(measuredAt);
      const capacityBytes = blockSize * blocks;
      const freeBytes = blockSize * freeBlocks;
      const availableBytes = blockSize * availableBlocks;
      if (![capacityBytes, freeBytes, availableBytes].every(Number.isSafeInteger) || capacityBytes <= 0) {
        return unknownStatus(measuredAt);
      }
      const usedBytes = capacityBytes - freeBytes;
      return {
        known: true,
        storageMode: String(storageMode || "unknown"),
        capacityBytes,
        usedBytes,
        freeBytes,
        availableBytes,
        headroomPercent: Number(((availableBytes / capacityBytes) * 100).toFixed(2)),
        measuredAt,
      };
    } catch {
      return unknownStatus(measuredAt);
    }
  }

  return {status};

  function unknownStatus(measuredAt) {
    return {known: false, storageMode: String(storageMode || "unknown"), measuredAt};
  }
}

function safeInteger(value) {
  if (typeof value === "bigint") return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return Number.isSafeInteger(value) ? value : null;
}

module.exports = {createDiskStatusService};
