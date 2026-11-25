const EXCLUDED_CLASSIFICATIONS = new Set(['excluded-ssh', 'excluded-n64']);
const TERMINAL_VM_STATES = new Set(['active', 'stopped']);
const DIGEST = /^[a-f0-9]{64}$/;

function invalid() {
  throw Error('migration_cohort_report_invalid');
}

function isSourceRetainedBlocked(record) {
  const report = record?.blockedReport;
  return report?.state === 'blocked' && report.decision === 'source-retained' &&
    report.sourceRetained === true && Array.isArray(report.blockers) && report.blockers.length > 0 &&
    DIGEST.test(String(record.sourceObservationSha256 || '')) &&
    report.sourceObservationSha256 === record.sourceObservationSha256 &&
    (record.sourceGeneration === null || Number.isSafeInteger(record.sourceGeneration)) &&
    report.sourceGeneration === record.sourceGeneration;
}

function isMigratedRuntime(runtime, record) {
  return runtime?.ownerUid === record.ownerUid && runtime.backend === 'compute-engine' &&
    runtime.migrationAuthority === 'compute-engine' && runtime.apiEnabled === true &&
    runtime.lifecycleEnabled === true && TERMINAL_VM_STATES.has(runtime.state);
}

function normalizeRuntimeRecords(records) {
  if (!Array.isArray(records)) invalid();
  const byWorkspace = new Map();
  for (const runtime of records) {
    if (!runtime || typeof runtime.workspaceId !== 'string' || !runtime.workspaceId || byWorkspace.has(runtime.workspaceId)) invalid();
    byWorkspace.set(runtime.workspaceId, runtime);
  }
  return byWorkspace;
}

// This audit is deliberately stricter than the dry-run inventory. It answers
// the parent issue's completion question: every in-scope legacy record must be
// migrated under VM authority or have an explicit source-retained blocker.
export function auditMigrationCohort(report, {now = Date.now()} = {}) {
  if (!report || report.schemaVersion !== 1 || report.readOnly !== true || !Array.isArray(report.workspaces) ||
      !Number.isSafeInteger(now) || now < 0) invalid();
  const runtimes = normalizeRuntimeRecords(report.existingVmRecords || []);
  const records = [];
  const seenWorkspaces = new Set();
  for (const record of report.workspaces) {
    if (!record || typeof record.workspaceId !== 'string' || !record.workspaceId || seenWorkspaces.has(record.workspaceId) ||
        typeof record.ownerUid !== 'string' || !record.ownerUid || typeof record.classification !== 'string') invalid();
    seenWorkspaces.add(record.workspaceId);
    const runtime = runtimes.get(record.workspaceId);
    let status;
    let blockers = [];
    if (EXCLUDED_CLASSIFICATIONS.has(record.classification)) {
      status = 'excluded';
    } else if (isSourceRetainedBlocked(record)) {
      status = 'blocked';
      blockers = [...record.blockedReport.blockers].sort();
    } else if (runtime && isMigratedRuntime(runtime, record)) {
      status = 'migrated';
    } else {
      status = 'unaccounted';
      blockers = runtime ? ['vm_runtime_authority_incomplete'] :
        (Array.isArray(record.blockers) && record.blockers.length ? [...new Set(record.blockers)].sort() : ['source_not_terminal']);
    }
    records.push({workspaceId: record.workspaceId, ownerUid: record.ownerUid, status, blockers});
  }

  const orphaned = [...runtimes.values()]
    .filter(runtime => runtime.migrationAuthority === 'compute-engine' && !seenWorkspaces.has(runtime.workspaceId))
    .map(runtime => ({workspaceId: runtime.workspaceId, ownerUid: runtime.ownerUid || null,
      blocker: 'migrated_runtime_without_legacy_record'}));
  const counts = records.reduce((result, record) => {
    result[record.status] = (result[record.status] || 0) + 1;
    return result;
  }, {excluded: 0, blocked: 0, migrated: 0, unaccounted: 0});
  const readyForCompletion = counts.unaccounted === 0 && orphaned.length === 0;
  return {
    schemaVersion: 1,
    readOnly: true,
    recordedAtMs: now,
    readyForCompletion,
    counts,
    workspaces: records,
    orphaned,
    scope: 'eligible legacy workspaces must be migrated under VM authority or explicitly source-retained; excluded SSH/N64 records are outside automatic migration',
  };
}

