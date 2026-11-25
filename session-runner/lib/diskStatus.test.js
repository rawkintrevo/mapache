"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createDiskStatusService} = require("./diskStatus");

test("reports guest filesystem capacity and available headroom without its path", async () => {
  const service = createDiskStatusService({root: "/private/retained-disk", storageMode: "retained-disk",
    now: () => "2026-11-24T00:00:00.000Z", statfs: async root => {
      assert.equal(root, "/private/retained-disk");
      return {bsize: 4096n, blocks: 100n, bfree: 25n, bavail: 20n};
    }});
  const result = await service.status();
  assert.deepEqual(result, {known: true, storageMode: "retained-disk", capacityBytes: 409600,
    usedBytes: 307200, freeBytes: 102400, availableBytes: 81920, headroomPercent: 20,
    measuredAt: "2026-11-24T00:00:00.000Z"});
  assert.doesNotMatch(JSON.stringify(result), /private|retained-disk\//);
});

test("fails closed to unknown disk status when the filesystem probe fails", async () => {
  const service = createDiskStatusService({root: "/private/retained-disk", storageMode: "retained-disk",
    now: () => "2026-11-24T00:00:00.000Z", statfs: async () => { throw new Error("probe failed"); }});
  assert.deepEqual(await service.status(), {known: false, storageMode: "retained-disk", measuredAt: "2026-11-24T00:00:00.000Z"});
});
