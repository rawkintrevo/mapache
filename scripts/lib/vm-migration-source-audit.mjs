import {createHash} from 'node:crypto';

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ALLOWED_READ_ONLY_BLOCKERS = new Set([
  'legacy_admission_fence_unverified',
  'live_compute_and_storage_authority_unverified',
  'untracked_legacy_upload_sessions_unverified',
]);
const SOURCE_BLOCKERS = new Set([
  'legacy_persistent_home_archive_missing',
  'vm_migration_storage_scope_unverified',
  'shared_source_unavailable',
  'legacy_source_capture_incomplete',
  'legacy_home_unavailable',
  'legacy_private_git_unavailable',
  'legacy_live_state_unavailable',
]);

const REQUIRED_COVERAGE = Object.freeze(['workspace', 'home', 'browser', 'uploads', 'ownerTools', 'privateGit', 'sharedTree', 'liveState']);

function fail(code) {
  throw Error(code);
}

function digest(value, name) {
  if (!DIGEST.test(String(value || ''))) fail(`${name}_invalid`);
  return String(value);
}

function identity(value, name) {
  if (!IDENTIFIER.test(String(value || ''))) fail(`${name}_invalid`);
  return String(value);
}

function boundedInteger(value, name, {allowNull = false} = {}) {
  if (allowNull && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name}_invalid`);
  return value;
}

function safeScope(scope) {
  if (!scope || typeof scope.bucket !== 'string' || !scope.bucket || typeof scope.prefix !== 'string' || !scope.prefix ||
      typeof scope.workspaceKey !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(scope.workspaceKey) ||
      scope.prefix.includes('\\') || scope.prefix.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('source_audit_scope_invalid');
  }
  return {bucket: scope.bucket, prefix: scope.prefix, workspaceKey: scope.workspaceKey};
}

function requiredCoverage({inventory, storageMetadata}) {
  const required = new Set(['workspace', 'liveState']);
  const roles = new Set((storageMetadata?.sources || []).flatMap(source => source.roles || []));
  if (['home', 'legacy-home', 'session-home'].some(role => roles.has(role))) required.add('home');
  if (['browser-archive', 'browser-seed'].some(role => roles.has(role))) required.add('browser');
  if (roles.has('uploads')) required.add('uploads');
  if (roles.has('owner-tools')) required.add('ownerTools');
  if (roles.has('shared-tree') || inventory?.formats?.includes('shared-gcs-tree')) required.add('sharedTree');
  if (inventory?.formats?.includes('git-backed') || (storageMetadata?.sources || []).some(source =>
    Object.prototype.hasOwnProperty.call(source.categories || {}, 'private-git-archive'))) required.add('privateGit');
  return [...required].sort((a, b) => REQUIRED_COVERAGE.indexOf(a) - REQUIRED_COVERAGE.indexOf(b));
}

function normalizeCoverage(coverage, required) {
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) fail('source_audit_coverage_missing');
  const normalized = {};
  for (const key of REQUIRED_COVERAGE) {
    const item = coverage[key];
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !['verified', 'not-applicable'].includes(item.status)) {
      if (required.includes(key)) fail(`source_audit_${key}_coverage_required`);
      normalized[key] = {status: 'not-applicable', reason: 'not-required'};
      continue;
    }
    if (item.status === 'verified') normalized[key] = {status: item.status, evidenceSha256: digest(item.evidenceSha256, `${key}_evidence`) };
    else if (typeof item.reason !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(item.reason)) fail(`source_audit_${key}_reason_invalid`);
    else normalized[key] = {status: item.status, reason: item.reason};
    if (required.includes(key) && normalized[key].status !== 'verified') fail(`source_audit_${key}_coverage_required`);
  }
  return normalized;
}

function normalizeStorage(storageMetadata) {
  if (!storageMetadata || !Array.isArray(storageMetadata.sources) || storageMetadata.sources.length < 1 ||
      !Array.isArray(storageMetadata.unresolved) || storageMetadata.unresolved.length ||
      storageMetadata.sourceTotalsMayOverlap !== true) fail('source_audit_storage_inventory_incomplete');
  const sources = storageMetadata.sources.map(source => {
    if (!source || !Array.isArray(source.roles) || !source.roles.length ||
        !DIGEST.test(String(source.prefixSha256 || '')) || !['listed-payloads-unverified', 'listed-empty'].includes(source.status) ||
        !Number.isSafeInteger(source.objects) || source.objects < 0 || !Number.isSafeInteger(source.storedBytes) || source.storedBytes < 0 ||
        !DIGEST.test(String(source.metadataEvidenceSha256 || ''))) fail('source_audit_storage_source_incomplete');
    let payloadVerification;
    if (source.objects > 0 && source.roles.includes('workspace')) {
      if (!source.payloadVerification || source.payloadVerification.status !== 'verified' ||
          source.payloadVerification.objects !== source.objects || source.payloadVerification.storedBytes !== source.storedBytes ||
          !DIGEST.test(String(source.payloadVerification.evidenceSha256 || ''))) fail('source_audit_storage_payload_unverified');
      payloadVerification = {status: 'verified', objects: source.payloadVerification.objects,
        storedBytes: source.payloadVerification.storedBytes, evidenceSha256: source.payloadVerification.evidenceSha256};
    }
    return {roles: [...new Set(source.roles)].sort(), prefixSha256: source.prefixSha256, status: source.status,
      objects: source.objects, storedBytes: source.storedBytes, metadataEvidenceSha256: source.metadataEvidenceSha256,
      ...(payloadVerification ? {payloadVerification} : {})};
  });
  return {sources, listedObjects: boundedInteger(storageMetadata.listedObjects, 'source_audit_listed_objects'), maxObjects: boundedInteger(storageMetadata.maxObjects, 'source_audit_max_objects')};
}

function normalizeCost(costDowntime) {
  if (!costDowntime || costDowntime.approved !== true || typeof costDowntime.currency !== 'string' ||
      costDowntime.currency !== 'USD' || typeof costDowntime.estimateSha256 !== 'string') fail('source_audit_cost_estimate_required');
  const estimateSha256 = digest(costDowntime.estimateSha256, 'source_audit_cost_estimate');
  const estimatedCostUsd = Number(costDowntime.estimatedCostUsd);
  const maxDowntimeSeconds = Number(costDowntime.maxDowntimeSeconds);
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0 || !Number.isFinite(maxDowntimeSeconds) || maxDowntimeSeconds < 0) {
    fail('source_audit_cost_estimate_invalid');
  }
  return {approved: true, currency: 'USD', estimatedCostUsd, maxDowntimeSeconds, estimateSha256};
}

function sourceAuditEvidenceSha256(audit) {
  return createHash('sha256').update(JSON.stringify({schemaVersion: audit.schemaVersion,
    state: audit.state, decision: audit.decision, workspaceId: audit.workspaceId, ownerUid: audit.ownerUid,
    sourceGeneration: audit.sourceGeneration, observationSha256: audit.observationSha256,
    sourceObservationSha256: audit.sourceObservationSha256, scope: audit.scope, blockers: audit.blockers,
    sourceRetained: audit.sourceRetained, completeness: audit.completeness})).digest('hex');
}

// Builds a durable admission proof. A blocked result is intentionally useful:
// it records exactly which source-evidence gate is still missing without ever
// making an incomplete source eligible for a migration fence.
export function buildSourceAudit({preflight, inventory, storageMetadata, scope, coverage, costDowntime, now = Date.now()}) {
  if (!preflight || preflight.readOnly !== true) fail('source_audit_preflight_invalid');
  const workspaceId = identity(preflight.workspaceId, 'workspace');
  const ownerUid = identity(preflight.ownerUid, 'owner');
  const observationSha256 = digest(preflight.observationSha256, 'source_audit_observation');
  const sourceObservationSha256 = digest(preflight.sourceObservationSha256, 'source_audit_source_observation');
  const sourceGeneration = boundedInteger(preflight.sourceGeneration, 'source_audit_source_generation', {allowNull: true});
  if (inventory && (inventory.workspaceId !== workspaceId || inventory.ownerUid !== ownerUid)) fail('source_audit_inventory_identity_invalid');
  const normalizedScope = safeScope(scope);
  const normalizedStorage = normalizeStorage(storageMetadata);
  const required = requiredCoverage({inventory, storageMetadata});
  const normalizedCoverage = normalizeCoverage(coverage, required);
  const normalizedCost = normalizeCost(costDowntime);
  if (!Number.isSafeInteger(now) || now < 0) fail('source_audit_timestamp_invalid');

  const preflightBlockers = [...new Set((preflight.blockers || []).filter(value => typeof value === 'string'))].sort();
  const blockers = preflightBlockers.filter(blocker => !ALLOWED_READ_ONLY_BLOCKERS.has(blocker));
  for (const blocker of preflightBlockers) if (SOURCE_BLOCKERS.has(blocker) && !blockers.includes(blocker)) blockers.push(blocker);
  if (!preflight.compute || preflight.compute.recordedComputeClear !== true || preflight.compute.blockers?.length ||
      preflight.compute.discovery?.scannedRegionsClear !== true) blockers.push('legacy_live_state_unavailable');
  if (!preflight.storage || preflight.storage.stable !== true || preflight.storage.blockers?.length ||
      preflight.storage.firstSha256 !== preflight.storage.secondSha256) blockers.push('vm_migration_storage_scope_unverified');
  const uniqueBlockers = [...new Set(blockers)].sort();
  const completeness = {requiredCoverage: required, coverage: normalizedCoverage, storage: normalizedStorage, costDowntime: normalizedCost};
  const audit = {schemaVersion: 1, state: uniqueBlockers.length ? 'blocked' : 'ready',
    decision: uniqueBlockers.length ? 'source-retained' : 'admit-reservation', workspaceId, ownerUid, sourceGeneration,
    observationSha256, sourceObservationSha256, scope: normalizedScope, blockers: uniqueBlockers,
    completeness, sourceRetained: true, recordedAtMs: now};
  return {...audit, evidenceSha256: sourceAuditEvidenceSha256(audit)};
}

export function assertReadySourceAudit(audit, {workspaceId, ownerUid, sourceGeneration, observationSha256, sourceObservationSha256, scope}) {
  if (!audit || audit.schemaVersion !== 1 || audit.state !== 'ready' || audit.decision !== 'admit-reservation' ||
      audit.workspaceId !== workspaceId || audit.ownerUid !== ownerUid || audit.sourceGeneration !== sourceGeneration ||
      audit.observationSha256 !== observationSha256 || audit.sourceObservationSha256 !== sourceObservationSha256 ||
      JSON.stringify(audit.scope) !== JSON.stringify(scope) ||
      audit.sourceRetained !== true || !audit.completeness || !DIGEST.test(String(audit.evidenceSha256 || '')) ||
      audit.evidenceSha256 !== sourceAuditEvidenceSha256(audit) ||
      !Array.isArray(audit.blockers) || audit.blockers.length) fail('source_audit_not_ready');
  return audit;
}

export {REQUIRED_COVERAGE};
