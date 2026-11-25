import test from 'node:test';
import assert from 'node:assert/strict';
import {auditMigrationCohort} from './vm-migration-cohort-audit.mjs';

const base = (overrides = {}) => ({schemaVersion: 1, readOnly: true, workspaces: [], existingVmRecords: [], ...overrides});
const workspace = (id, overrides = {}) => ({workspaceId: id, ownerUid: `owner-${id}`, classification: 'inactive', blockers: ['source_not_terminal'], ...overrides});
const migrated = (id, overrides = {}) => ({workspaceId: id, ownerUid: `owner-${id}`, backend: 'compute-engine',
  migrationAuthority: 'compute-engine', apiEnabled: true, lifecycleEnabled: true, state: 'stopped', ...overrides});
const digest = value => value.repeat(64);

test('cohort audit accepts excluded and explicitly source-retained records', () => {
  const result = auditMigrationCohort(base({workspaces: [
    workspace('ssh', {classification: 'excluded-ssh'}),
    workspace('blocked', {sourceGeneration: 2, sourceObservationSha256: digest('a'), blockedReport: {
      state: 'blocked', decision: 'source-retained', sourceGeneration: 2,
      sourceObservationSha256: digest('a'), sourceRetained: true, blockers: ['home_missing'],
    }}),
  ]}), {now: 123});
  assert.equal(result.readyForCompletion, true);
  assert.deepEqual(result.counts, {excluded: 1, blocked: 1, migrated: 0, unaccounted: 0});
  assert.equal(result.recordedAtMs, 123);
});

test('cohort audit accepts a fully admitted VM runtime as migrated', () => {
  const result = auditMigrationCohort(base({workspaces: [workspace('migrated')], existingVmRecords: [migrated('migrated')]}));
  assert.equal(result.readyForCompletion, true);
  assert.equal(result.workspaces[0].status, 'migrated');
});

test('cohort audit keeps a pending source unaccounted', () => {
  const result = auditMigrationCohort(base({workspaces: [workspace('pending')]}));
  assert.equal(result.readyForCompletion, false);
  assert.deepEqual(result.workspaces[0].blockers, ['source_not_terminal']);
  assert.equal(result.counts.unaccounted, 1);
});

test('cohort audit does not count a stale blocked report as complete', () => {
  const result = auditMigrationCohort(base({workspaces: [workspace('stale', {
    blockers: ['source_observation_changed'], sourceGeneration: 2, sourceObservationSha256: digest('a'),
    blockedReport: {state: 'blocked', decision: 'source-retained', sourceGeneration: 2,
      sourceObservationSha256: digest('b'), sourceRetained: true, blockers: ['home_missing']},
  })]}));
  assert.equal(result.readyForCompletion, false);
  assert.equal(result.workspaces[0].status, 'unaccounted');
  assert.deepEqual(result.workspaces[0].blockers, ['source_observation_changed']);
});

test('cohort audit rejects an incomplete VM authority record', () => {
  const result = auditMigrationCohort(base({workspaces: [workspace('partial')], existingVmRecords: [migrated('partial', {apiEnabled: false})]}));
  assert.equal(result.readyForCompletion, false);
  assert.deepEqual(result.workspaces[0].blockers, ['vm_runtime_authority_incomplete']);
});

test('cohort audit reports orphaned migrated runtime records', () => {
  const result = auditMigrationCohort(base({workspaces: [workspace('known')], existingVmRecords: [migrated('known'), migrated('orphan')]}));
  assert.equal(result.readyForCompletion, false);
  assert.deepEqual(result.orphaned, [{workspaceId: 'orphan', ownerUid: 'owner-orphan', blocker: 'migrated_runtime_without_legacy_record'}]);
});

test('cohort audit rejects duplicate workspace or runtime records', () => {
  assert.throws(() => auditMigrationCohort(base({workspaces: [workspace('same'), workspace('same')]})), /migration_cohort_report_invalid/);
  assert.throws(() => auditMigrationCohort(base({existingVmRecords: [migrated('same'), migrated('same')]})), /migration_cohort_report_invalid/);
});

