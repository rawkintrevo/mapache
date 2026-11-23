"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {uploadCheckpointBatches} = require("./checkpointUploadBatch");

test("uploads concurrently within request and byte limits", async () => {
  for (const [size, limit] of [[1, 64], [32 * 1024 * 1024, 2], [100 * 1024 * 1024, 1]]) {
    let active = 0;
    let peak = 0;
    let completed = 0;
    await uploadCheckpointBatches({
      files: Array.from({length: 129}, (_, i) => i),
      sizeOf: async () => size,
      upload: async () => {
        peak = Math.max(peak, ++active);
        await new Promise(setImmediate);
        active--;
        completed++;
      },
    });
    assert.equal(peak, limit);
    assert.equal(completed, 129);
  }
});

test("drains in-flight uploads on failure without starting another batch", async () => {
  const completed = [];
  await assert.rejects(uploadCheckpointBatches({
    files: Array.from({length: 129}, (_, i) => i),
    sizeOf: async () => 1,
    upload: async (i) => {
      if (i === 0) throw new Error("upload failed");
      await new Promise(setImmediate);
      completed.push(i);
    },
  }), /upload failed/);
  assert.deepEqual(completed, Array.from({length: 63}, (_, i) => i + 1));
});
