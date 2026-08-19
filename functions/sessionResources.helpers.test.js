"use strict";

const assert = require("assert");
const catalog = require("./sessionResourceCatalog.json");
const {
  calculateEstimatedHourlyPrice,
  calculateEstimatedUsageCostUsd,
  inferSessionSize,
  isValidSessionResourcePair,
  normalizeSessionResources,
  parseMemoryGiB,
  validateSessionResourceCatalog,
} = require("./sessionResources.helpers");

assert.strictEqual(validateSessionResourceCatalog(catalog), true);
assert.strictEqual(parseMemoryGiB("512Mi"), 0.5);
assert.strictEqual(parseMemoryGiB("2Gi"), 2);
assert.strictEqual(parseMemoryGiB("2GiB"), 2);
assert.strictEqual(parseMemoryGiB("bad"), null);

assert.strictEqual(isValidSessionResourcePair("1", "1Gi"), true);
assert.strictEqual(isValidSessionResourcePair("1", "8Gi"), false);
assert.strictEqual(isValidSessionResourcePair("4", "1Gi"), false);
assert.strictEqual(isValidSessionResourcePair("4", "2Gi"), true);
assert.strictEqual(isValidSessionResourcePair("3", "2Gi"), false);

assert.deepStrictEqual(normalizeSessionResources({}), {cpu: "1", memory: "2Gi"});
assert.deepStrictEqual(normalizeSessionResources({cpu: "2", memory: "2Gi"}), {cpu: "2", memory: "2Gi"});
assert.throws(
    () => normalizeSessionResources({cpu: "1"}, {defaultResources: null}),
    (error) => error.code === "invalid_session_resources",
);
assert.throws(
    () => normalizeSessionResources({cpu: "1", memory: "8Gi"}),
    (error) => error.code === "invalid_session_resources",
);

assert.strictEqual(inferSessionSize("1", "2Gi"), "small");
assert.strictEqual(inferSessionSize("2", "4Gi"), "medium");
assert.strictEqual(inferSessionSize("4", "8Gi"), "large");
assert.strictEqual(inferSessionSize("1", "1Gi"), "custom");

assert.strictEqual(calculateEstimatedHourlyPrice("1", "2Gi"), 0.0792);
assert.strictEqual(calculateEstimatedHourlyPrice("2", "4Gi"), 0.1584);
assert.strictEqual(calculateEstimatedHourlyPrice("4", "8Gi"), 0.3168);
assert.strictEqual(calculateEstimatedHourlyPrice("1", "512Mi"), 0.0684);
assert.strictEqual(calculateEstimatedHourlyPrice("bad", "2Gi"), null);
assert.strictEqual(calculateEstimatedUsageCostUsd({cpuSeconds: 3600, memoryGbSeconds: 7200}), 0.0792);

assert.throws(
    () => validateSessionResourceCatalog({
      ...catalog,
      presets: [{...catalog.presets[0], memory: "8Gi"}],
    }),
    /invalid_session_resource_catalog_preset_pair/,
);

console.log("session resource helper tests passed");
