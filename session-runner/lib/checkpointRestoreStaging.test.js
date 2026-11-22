"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {stageCheckpointFiles} = require("./checkpointRestoreStaging");

test("restores small SDK objects with bounded parallelism", async () => {
  const files = Array.from({length: 130}, (_, i) => ({entry: {byteLength: 1024}, stagedPath: `/stage/${i}`}));
  let active = 0;
  let peak = 0;
  let completed = 0;
  await stageCheckpointFiles({files, stageFile: async () => {
    active++;
    peak = Math.max(peak, active);
    assert.ok(active <= 64);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    completed++;
  }});
  assert.equal(peak, 64);
  assert.equal(completed, files.length);
});

test("drains failed download batches before rejecting and never starts later files", async () => {
  const files = Array.from({length: 65}, (_, i) => ({entry: {byteLength: 1}, stagedPath: `/stage/${i}`, index: i}));
  let completed = 0;
  let started = 0;
  await assert.rejects(stageCheckpointFiles({files, stageFile: async (file) => {
    started++;
    if (file.index === 0) throw new Error("download failed");
    await new Promise((resolve) => setImmediate(resolve));
    completed++;
  }}), /download failed/);
  assert.equal(started, 64);
  assert.equal(completed, 63);
});

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
