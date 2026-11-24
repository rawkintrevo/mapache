import assert from "node:assert/strict";
import test from "node:test";
import {parseArgs} from "./vm-grow-filesystem.mjs";
import {filesystemProjection, parseConfig, validateMarker} from "./vm-grow-filesystem-remote.mjs";

const baseArgs = ["--project=pi-agents-cloud", "--workspace=workspace-1", "--owner=owner-1",
  "--generation=2", "--size-gb=128", "--maintenance-instance=maintenance-1", "--maintenance-id=12345", "--confirm-grow"];

test("filesystem growth operator requires explicit project, maintenance identity, and confirmation", () => {
  assert.deepEqual(parseArgs(baseArgs), {
    project: "pi-agents-cloud", workspace: "workspace-1", owner: "owner-1", generation: 2, sizeGb: 128,
    maintenanceInstance: "maintenance-1", maintenanceId: "12345", confirmGrow: true,
  });
  assert.throws(() => parseArgs(baseArgs.filter(value => value !== "--confirm-grow")), /confirm-grow/);
  assert.throws(() => parseArgs(baseArgs.map(value => value === "--project=pi-agents-cloud" ? "--project=wrong" : value)), /project/);
  assert.throws(() => parseArgs(baseArgs.map(value => value === "--maintenance-id=12345" ? "--maintenance-id=not-an-id" : value)), /maintenance-id/);
  assert.throws(() => parseArgs(baseArgs.map(value => value === "--size-gb=128" ? "--size-gb=9" : value)), /size-gb/);
});

test("remote config and marker are bound to the exact workspace disk generation", () => {
  const config = parseConfig({projectId: "pi-agents-cloud", workspaceId: "workspace-1", ownerUid: "owner-1",
    generation: "2", diskName: "mapache-ws-0123456789abcdef01234567", expectedSizeGb: "128",
    maintenanceId: "12345", zone: "us-central1-a"});
  assert.equal(config.generation, 2);
  assert.equal(config.expectedSizeGb, 128);
  validateMarker({version: 1, kind: "retained-disk", workspaceId: "workspace-1", ownerUid: "owner-1", generation: 2}, config);
  assert.throws(() => validateMarker({version: 1, kind: "retained-disk", workspaceId: "other", ownerUid: "owner-1", generation: 2}, config),
    /filesystem_growth_marker_mismatch/);
});

test("filesystem evidence reports measured capacity without exposing its mount path", () => {
  const evidence = filesystemProjection({bsize: 4096n, blocks: 100n, bfree: 25n, bavail: 20n}, "2026-11-24T00:00:00.000Z");
  assert.deepEqual(evidence, {type: "ext4", capacityBytes: 409600, usedBytes: 307200,
    freeBytes: 102400, availableBytes: 81920, headroomPercent: 20, checkedAt: "2026-11-24T00:00:00.000Z"});
  assert.doesNotMatch(JSON.stringify(evidence), /workspace|private|mount/);
});
