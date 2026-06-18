"use strict";

const assert = require("assert");
const {
  estimatedUsageCostUsd,
  normalizePageSize,
  requireAdmin,
} = require("./admin.service");

assert.strictEqual(normalizePageSize(), 25);
assert.strictEqual(normalizePageSize("0"), 25);
assert.strictEqual(normalizePageSize("10"), 10);
assert.strictEqual(normalizePageSize("500"), 50);

assert.strictEqual(estimatedUsageCostUsd({
  cpuSeconds: 1000,
  memoryGbSeconds: 500,
}), 0.019);
assert.strictEqual(estimatedUsageCostUsd({}), 0);

assert.doesNotThrow(() => requireAdmin({uid: "admin-1", isAdmin: true}));
assert.throws(() => requireAdmin({uid: "user-1"}), /admin_required/);
assert.throws(() => requireAdmin(null), /admin_required/);

console.log("admin service tests passed");
