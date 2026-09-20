"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {parseArgs} = require("./shared-workspace-migration");

test("migration worker parses its scoped import descriptor", () => {
  assert.deepEqual(parseArgs([
    "--source-root", "/var/lib/mapache/staging/workspace-1",
    "--bucket", "mpw-123-workspace",
    "--operation-id", "shared-storage-workspace-1",
  ]), {
    sourceRoot: "/var/lib/mapache/staging/workspace-1",
    bucket: "mpw-123-workspace",
    operationId: "shared-storage-workspace-1",
  });
});

test("migration worker rejects an unscoped import", () => {
  assert.throws(() => parseArgs(["--source-root"]), /missing value/);
});
