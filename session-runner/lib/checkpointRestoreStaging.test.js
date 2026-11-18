"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {stageCheckpointFiles} = require("./checkpointRestoreStaging");

test("bounds buffered bytes and stages an oversized object alone", async () => {
  const MiB = 1024 * 1024;
  const sizes = [32, 32, 32, 90, 32, 32];
  const files = sizes.map((size, i) => ({entry: {byteLength: size * MiB}, stagedPath: `/stage/${i}`}));
  let bytes = 0;
  let active = 0;
  let peak = 0;
  await stageCheckpointFiles({files, stageFile: async (file) => {
    bytes += file.entry.byteLength;
    active++;
    peak = Math.max(peak, active);
    assert.ok(bytes <= 64 * MiB || active === 1);
    if (file.entry.byteLength > 64 * MiB) assert.equal(active, 1);
    await new Promise((resolve) => setImmediate(resolve));
    bytes -= file.entry.byteLength;
    active--;
  }});
  assert.equal(peak, 2);
  assert.equal(bytes, 0);
});
