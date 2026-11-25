const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// These are source-evidence failures, rather than ordinary drain or provider
// retry conditions. Recording one is an explicit blocked outcome; it never
// makes the source eligible for cutover.
export const SOURCE_BLOCKERS = new Set([
  "legacy_persistent_home_archive_missing",
  "vm_migration_storage_scope_unverified",
  "shared_source_unavailable",
  "legacy_source_capture_incomplete",
  "legacy_home_unavailable",
  "legacy_private_git_unavailable",
  "legacy_live_state_unavailable",
]);

function boundedInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function boundedDigest(value, name) {
  if (!DIGEST.test(String(value || ""))) throw Error(`${name}_invalid`);
  return String(value);
}

function boundedIdentity(value, name) {
  if (!IDENTIFIER.test(String(value || ""))) throw Error(`${name}_invalid`);
  return String(value);
}

function safeCompute(compute = {}) {
  const discovery = compute.discovery || {};
  return {
    referencedServices: boundedInteger(compute.referencedServices),
    absentServices: boundedInteger(compute.absentServices),
    terminalOperations: boundedInteger(compute.terminalOperations),
    recordedComputeClear: compute.recordedComputeClear === true,
    blockers: Array.isArray(compute.blockers) ? [...new Set(compute.blockers.filter(value => /^[a-z0-9_]+$/.test(value)))].sort() : [],
    discovery: {
      regions: Array.isArray(discovery.regions) ? discovery.regions.filter(value => /^[a-z0-9-]+$/.test(value)).sort() : [],
      inspectedServices: boundedInteger(discovery.inspectedServices),
      matchingServices: boundedInteger(discovery.matchingServices),
      unrecordedMatches: boundedInteger(discovery.unrecordedMatches),
      unidentifiedRunnerServices: boundedInteger(discovery.unidentifiedRunnerServices),
      scannedRegionsClear: discovery.scannedRegionsClear === true,
      evidenceSha256: DIGEST.test(String(discovery.evidenceSha256 || "")) ? String(discovery.evidenceSha256) : null,
    },
  };
}

function safeStorage(storage = {}) {
  return {
    stable: storage.stable === true,
    observedObjects: boundedInteger(storage.observedObjects),
    firstSha256: DIGEST.test(String(storage.firstSha256 || "")) ? String(storage.firstSha256) : null,
    secondSha256: DIGEST.test(String(storage.secondSha256 || "")) ? String(storage.secondSha256) : null,
    blockers: Array.isArray(storage.blockers) ? [...new Set(storage.blockers.filter(value => /^[a-z0-9_]+$/.test(value)))].sort() : [],
  };
}

export function buildBlockedSourceReport({preflight, expectedObservationSha256, workspaceId, ownerUid, now = Date.now()}) {
  if (!preflight || preflight.readOnly !== true || preflight.readyForFreeze === true || preflight.readyForCutover === true) {
    throw Error("blocked_source_preflight_invalid");
  }
  const observationSha256 = boundedDigest(preflight.observationSha256, "observation");
  if (observationSha256 !== boundedDigest(expectedObservationSha256, "observation")) {
    throw Error("blocked_source_observation_stale");
  }
  const sourceObservationSha256 = boundedDigest(preflight.sourceObservationSha256, "source_observation");
  const normalizedBlockers = [...new Set((Array.isArray(preflight.blockers) ? preflight.blockers : [])
    .filter(value => /^[a-z0-9_]+$/.test(value)))].sort();
  if (!normalizedBlockers.some(blocker => SOURCE_BLOCKERS.has(blocker))) {
    throw Error("blocked_source_decision_requires_source_blocker");
  }
  if (normalizedBlockers.includes("migration_fence_already_exists")) {
    throw Error("blocked_source_migration_active");
  }
  const normalizedWorkspaceId = boundedIdentity(workspaceId, "workspace");
  const normalizedOwnerUid = boundedIdentity(ownerUid, "owner");
  if (!Number.isSafeInteger(now) || now < 0) throw Error("blocked_source_timestamp_invalid");
  return {
    schemaVersion: 1,
    state: "blocked",
    decision: "source-retained",
    workspaceId: normalizedWorkspaceId,
    ownerUid: normalizedOwnerUid,
    sourceGeneration: Number.isSafeInteger(preflight.sourceGeneration) ? preflight.sourceGeneration : null,
    observationSha256,
    sourceObservationSha256,
    blockers: normalizedBlockers,
    counts: {
      observedSessions: boundedInteger(preflight.counts?.observedSessions),
      possiblyActiveSessions: boundedInteger(preflight.counts?.possiblyActiveSessions),
      failedStops: boundedInteger(preflight.counts?.failedStops),
      observedQueuedOrActiveRuns: boundedInteger(preflight.counts?.observedQueuedOrActiveRuns),
    },
    compute: safeCompute(preflight.compute),
    storage: safeStorage(preflight.storage),
    sourceRetained: true,
    recordedAtMs: now,
  };
}

