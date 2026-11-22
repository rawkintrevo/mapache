"use strict";

// Bound both request fan-out and the file buffers held by an upload batch.
// Oversized files run alone. Drain failures before returning to the caller so
// a subsequent checkpoint cannot race uploads left running by this one.
async function uploadCheckpointBatches({files, sizeOf, upload}) {
  let batch = [];
  let bytes = 0;
  async function drain() {
    const results = await Promise.allSettled(batch.map(upload));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    batch = [];
    bytes = 0;
  }
  for (const file of files) {
    const size = await sizeOf(file);
    if (batch.length && (batch.length >= 8 || bytes + size > 64 * 1024 * 1024)) await drain();
    batch.push(file);
    bytes += size;
  }
  if (batch.length) await drain();
}

module.exports = {uploadCheckpointBatches};
