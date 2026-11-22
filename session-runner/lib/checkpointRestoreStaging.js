"use strict";

const path = require("node:path");

// Tool installations contain tens of thousands of small objects. Allow more
// requests while the independent byte budget still bounds buffered content.
const MAX_DOWNLOADS = 64;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;

// Validate the complete path plan before creating anything. A symlink (or file)
// must never become another entry's parent during concurrent staging.
function validateStagingPaths(files) {
  const paths = new Set();
  for (const file of files) {
    if (paths.has(file.stagedPath)) throw invalidPaths();
    paths.add(file.stagedPath);
  }
  for (const file of files) {
    let parent = path.dirname(file.stagedPath);
    while (parent !== path.dirname(parent)) {
      if (paths.has(parent)) throw invalidPaths();
      parent = path.dirname(parent);
    }
  }
}

function invalidPaths() {
  return Object.assign(new Error("Checkpoint contains conflicting staging paths"), {code: "checkpoint_manifest_invalid"});
}

async function stageCheckpointFiles({files, fsImpl, stageFile}) {
  validateStagingPaths(files);
  const regularFiles = files.filter((file) => !file.symlink);
  let index = 0;
  while (index < regularFiles.length) {
    const batch = [];
    let bytes = 0;
    while (index < regularFiles.length && batch.length < MAX_DOWNLOADS) {
      const file = regularFiles[index];
      const size = file.deferred ? 0 : Math.max(0, Number(file.entry.byteLength) || 0);
      // One oversized entry may run alone; never multiply its memory cost.
      if (batch.length && bytes + size > MAX_BATCH_BYTES) break;
      batch.push(file);
      bytes += size;
      index++;
    }
    // Drain every in-flight write before callers remove staging directories.
    // Promise.all's early rejection would race cleanup and recreate files.
    const results = await Promise.allSettled(batch.map((file) => stageFile(file)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  // Only materialize links after all ordinary files have been verified/written.
  for (const file of files.filter((file) => file.symlink)) {
    await fsImpl.promises.mkdir(path.dirname(file.stagedPath), {recursive: true});
    await fsImpl.promises.symlink(file.entry.target, file.stagedPath);
  }
}

module.exports = {stageCheckpointFiles};
