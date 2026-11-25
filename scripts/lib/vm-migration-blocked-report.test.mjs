import assert from "node:assert/strict";
import test from "node:test";
import {buildBlockedSourceReport} from "./vm-migration-blocked-report.mjs";

const digest = "a".repeat(64);
const preflight = overrides => ({
  readOnly: true,
  readyForFreeze: false,
  readyForCutover: false,
  observationSha256: digest,
  sourceObservationSha256: "b".repeat(64),
  sourceGeneration: 2,
  blockers: ["legacy_persistent_home_archive_missing", "untracked_legacy_upload_sessions_unverified"],
  counts: {observedSessions: 1, possiblyActiveSessions: 0, failedStops: 0, observedQueuedOrActiveRuns: 0},
  compute: {recordedComputeClear: true, discovery: {scannedRegionsClear: true, evidenceSha256: "c".repeat(64)}},
  storage: {stable: true, observedObjects: 4, firstSha256: "d".repeat(64), secondSha256: "d".repeat(64)},
  ...overrides,
});

test("builds a bounded source-retained blocked report", () => {
  const report = buildBlockedSourceReport({preflight: preflight(), expectedObservationSha256: digest,
    workspaceId: "workspace-1", ownerUid: "owner-1", now: 123});
  assert.deepEqual(report, {
    schemaVersion: 1,
    state: "blocked",
    decision: "source-retained",
    workspaceId: "workspace-1",
    ownerUid: "owner-1",
    sourceGeneration: 2,
    observationSha256: digest,
    sourceObservationSha256: "b".repeat(64),
    blockers: ["legacy_persistent_home_archive_missing", "untracked_legacy_upload_sessions_unverified"],
    counts: {observedSessions: 1, possiblyActiveSessions: 0, failedStops: 0, observedQueuedOrActiveRuns: 0},
    compute: {referencedServices: 0, absentServices: 0, terminalOperations: 0, recordedComputeClear: true,
      blockers: [], discovery: {regions: [], inspectedServices: 0, matchingServices: 0, unrecordedMatches: 0,
        unidentifiedRunnerServices: 0, scannedRegionsClear: true, evidenceSha256: "c".repeat(64)}},
    storage: {stable: true, observedObjects: 4, firstSha256: "d".repeat(64), secondSha256: "d".repeat(64), blockers: []},
    sourceRetained: true,
    recordedAtMs: 123,
  });
});

test("requires a source blocker and fresh observation", () => {
  assert.throws(() => buildBlockedSourceReport({preflight: preflight({blockers: ["legacy_sessions_require_quiesce"]}),
    expectedObservationSha256: digest, workspaceId: "workspace-1", ownerUid: "owner-1"}),
  /blocked_source_decision_requires_source_blocker/);
  assert.throws(() => buildBlockedSourceReport({preflight: preflight(), expectedObservationSha256: "e".repeat(64),
    workspaceId: "workspace-1", ownerUid: "owner-1"}), /blocked_source_observation_stale/);
});

test("refuses an active migration fence", () => {
  assert.throws(() => buildBlockedSourceReport({preflight: preflight({blockers: [
    "migration_fence_already_exists", "legacy_persistent_home_archive_missing"]}), expectedObservationSha256: digest,
  workspaceId: "workspace-1", ownerUid: "owner-1"}), /blocked_source_migration_active/);
});

