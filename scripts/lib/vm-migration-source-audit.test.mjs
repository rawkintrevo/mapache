import assert from 'node:assert/strict';
import test from 'node:test';
import {buildSourceAudit, assertReadySourceAudit} from './vm-migration-source-audit.mjs';

const digest = value => value.repeat(64);
const base = () => ({
  preflight: {readOnly: true, workspaceId: 'workspace', ownerUid: 'owner', sourceGeneration: 4,
    observationSha256: digest('a'), sourceObservationSha256: digest('b'), blockers: [
      'legacy_admission_fence_unverified', 'live_compute_and_storage_authority_unverified',
      'untracked_legacy_upload_sessions_unverified'],
    compute: {recordedComputeClear: true, blockers: [], discovery: {scannedRegionsClear: true}},
    storage: {stable: true, blockers: [], firstSha256: digest('c'), secondSha256: digest('c')}},
  inventory: {workspaceId: 'workspace', ownerUid: 'owner', formats: []},
  storageMetadata: {unresolved: [], sourceTotalsMayOverlap: true, listedObjects: 3, maxObjects: 10, sources: [
    {roles: ['workspace'], prefixSha256: digest('d'), status: 'listed-payloads-unverified', objects: 1, storedBytes: 4, metadataEvidenceSha256: digest('e'),
      payloadVerification: {status: 'verified', objects: 1, storedBytes: 4, evidenceSha256: digest('a')}},
    {roles: ['browser-seed'], prefixSha256: digest('f'), status: 'listed-empty', objects: 0, storedBytes: 0, metadataEvidenceSha256: digest('0')},
    {roles: ['uploads'], prefixSha256: digest('1'), status: 'listed-empty', objects: 0, storedBytes: 0, metadataEvidenceSha256: digest('2')},
    {roles: ['owner-tools'], prefixSha256: digest('3'), status: 'listed-payloads-unverified', objects: 2, storedBytes: 8, metadataEvidenceSha256: digest('4')},
  ]},
  scope: {bucket: 'bucket', prefix: 'workspaces/owner/workspace', workspaceKey: 'workspace'},
  coverage: {
    workspace: {status: 'verified', evidenceSha256: digest('5')},
    browser: {status: 'verified', evidenceSha256: digest('6')},
    uploads: {status: 'verified', evidenceSha256: digest('7')},
    ownerTools: {status: 'verified', evidenceSha256: digest('8')},
    liveState: {status: 'verified', evidenceSha256: digest('9')},
    home: {status: 'not-applicable', reason: 'ephemeral'},
    privateGit: {status: 'not-applicable', reason: 'not-configured'},
    sharedTree: {status: 'not-applicable', reason: 'not-configured'},
  },
  costDowntime: {approved: true, currency: 'USD', estimatedCostUsd: 2.5, maxDowntimeSeconds: 180,
    estimateSha256: digest('a')},
  now: 42,
});

test('source audit is ready only when every discovered source has explicit coverage', () => {
  const audit = buildSourceAudit(base());
  assert.equal(audit.state, 'ready');
  assert.equal(audit.decision, 'admit-reservation');
  assert.deepEqual(audit.blockers, []);
  assert.doesNotThrow(() => assertReadySourceAudit(audit, {workspaceId: 'workspace', ownerUid: 'owner', sourceGeneration: 4,
    observationSha256: digest('a'),
    sourceObservationSha256: digest('b'), scope: {bucket: 'bucket', prefix: 'workspaces/owner/workspace', workspaceKey: 'workspace'}}));
});

test('missing coverage is rejected before an audit can be recorded', () => {
  const input = base();
  delete input.coverage.ownerTools;
  assert.throws(() => buildSourceAudit(input), {message: 'source_audit_ownerTools_coverage_required'});
});

test('source blockers and unstable provider evidence cannot become ready', () => {
  const input = base();
  input.preflight.blockers.push('legacy_persistent_home_archive_missing');
  input.preflight.storage.stable = false;
  const audit = buildSourceAudit(input);
  assert.equal(audit.state, 'blocked');
  assert.equal(audit.decision, 'source-retained');
  assert.deepEqual(audit.blockers, ['legacy_persistent_home_archive_missing', 'vm_migration_storage_scope_unverified']);
  assert.throws(() => assertReadySourceAudit(audit, {workspaceId: 'workspace', ownerUid: 'owner', sourceGeneration: 4,
    observationSha256: digest('a'),
    sourceObservationSha256: digest('b'), scope: {bucket: 'bucket', prefix: 'workspaces/owner/workspace', workspaceKey: 'workspace'}}), {message: 'source_audit_not_ready'});
});

test('metadata-only non-empty workspace storage cannot become audit-ready', () => {
  const input = base();
  delete input.storageMetadata.sources[0].payloadVerification;
  assert.throws(() => buildSourceAudit(input), {message: 'source_audit_storage_payload_unverified'});
});

test('a changed source observation invalidates a ready audit', () => {
  const audit = buildSourceAudit(base());
  assert.throws(() => assertReadySourceAudit(audit, {workspaceId: 'workspace', ownerUid: 'owner', sourceGeneration: 5,
    observationSha256: digest('a'),
    sourceObservationSha256: digest('b'), scope: {bucket: 'bucket', prefix: 'workspaces/owner/workspace', workspaceKey: 'workspace'}}), {message: 'source_audit_not_ready'});
});
