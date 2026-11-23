import {createHash} from 'node:crypto';

const ACTIVE = new Set(['provisioning', 'running', 'ready', 'restarting', 'resizing', 'needs_service', 'stopping', 'deleting']);
const relative = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
  !value.split('/').some(part => !part || part === '.' || part === '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Inventory deliberately cannot publish a pointer, pause a writer or create a
// resource. Only the injected reader can access storage; no write API is used.
export async function inspectMigrationSource({workspaceId, workspace, sessions, readManifest}) {
  const blockers = new Set();
  const formats = new Set();
  const sources = [];
  const ssh = workspace.source === 'ssh' || workspace.source?.type === 'ssh' || workspace.runtimeProvider?.backend === 'ssh' || sessions.some(s => s.runtimeProvider?.backend === 'ssh' || s.terminalKind === 'ssh');
  const n64 = workspace.imageKey === 'pi-n64' || sessions.some(s => s.imageKey === 'pi-n64');
  if (!workspace.ownerUid) blockers.add('owner_missing');
  if (ssh) blockers.add('ssh_automatic_migration_excluded');
  if (n64) blockers.add('n64_automatic_migration_excluded');
  if (sessions.some(s => s.ownerUid && s.ownerUid !== workspace.ownerUid)) blockers.add('session_owner_mismatch');
  const live = sessions.filter(s => ACTIVE.has(s.status));
  const failedStop = sessions.some(s => s.status === 'stop_failed');
  if (live.length) blockers.add('writers_require_quiesce_and_final_capture');
  if (failedStop) blockers.add('failed_stop_requires_compute_reconciliation');
  if (workspace.deleted || ['deleting', 'deleted'].includes(workspace.status || workspace.lifecycle)) blockers.add('workspace_deletion_requires_reconciliation');
  if (workspace.source?.type === 'github') formats.add('git-backed');
  if (workspace.sharedStorage?.bucketName) {
    formats.add('shared-gcs-tree');
    sources.push({kind: 'shared-tree', bucketName: workspace.sharedStorage.bucketName,
      generation: workspace.sharedStorage.storageGeneration || null, validation: 'not-read'});
    blockers.add('shared_tree_marker_and_objects_not_verified');
  }
  let knownLogicalBytes = 0;
  for (const [field, kind] of [['agentRuntimeCheckpoint', 'agent'], ['agentRuntimeWorkspaceFiles', 'workspace']]) {
    const pointer = workspace[field];
    if (!pointer) continue;
    const source = {kind, captureId: pointer.captureId || null, generation: pointer.generation || null,
      capturedAt: pointer.capturedAt || null, validation: 'unverified', fileCount: 0, logicalBytes: 0};
    sources.push(source);
    try {
      const ref = pointer.manifest;
      if (!ref || typeof ref.bucketName !== 'string' || !relative(ref.objectPath) || !/^[a-f0-9]{64}$/.test(ref.sha256 || '') ||
          !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 || ref.byteLength > 16 * 1024 * 1024) throw Error('invalid_reference');
      const {content, objectGeneration} = await readManifest(ref);
      if (content.length !== ref.byteLength || digest(content) !== ref.sha256) throw Error('manifest_checksum_mismatch');
      const manifest = JSON.parse(content.toString('utf8'));
      if (manifest.manifestVersion !== 1 || manifest.workspaceId !== workspaceId || manifest.generation !== pointer.generation ||
          manifest.bootInstanceId !== pointer.bootInstanceId || !sessions.some(s => s.id === manifest.sessionId) ||
          manifest.kind !== (kind === 'agent' ? 'mapache-agent-state-snapshot' : 'mapache-workspace-file-state') || !Array.isArray(manifest.files)) throw Error('manifest_identity_or_schema_mismatch');
      const seen = new Set();
      const counts = {};
      for (const entry of manifest.files) {
        if (!relative(entry.path) || seen.has(entry.path) || !Number.isSafeInteger(entry.byteLength ?? 0) || (entry.byteLength ?? 0) < 0) throw Error('manifest_entry_invalid');
        seen.add(entry.path);
        const format = entry.kind === 'symlink' ? 'symlink' : entry.storage || 'per-file';
        if (!['per-file', 'workspace-bundle-v1', 'large-file-v1', 'symlink'].includes(format)) throw Error('manifest_storage_unsupported');
        if (format !== 'symlink' && (!Number.isSafeInteger(entry.byteLength) || !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))) throw Error('manifest_entry_invalid');
        formats.add(format); counts[format] = (counts[format] || 0) + 1;
        if (format === 'workspace-bundle-v1' && (!relative(entry.bundle?.objectPath) || !Number.isSafeInteger(entry.bundleOffset) || entry.bundleOffset < 0 ||
            !Number.isSafeInteger(entry.bundle.byteLength) || !/^[a-f0-9]{64}$/.test(entry.bundle.sha256 || '') || entry.bundleOffset + entry.byteLength > entry.bundle.byteLength)) throw Error('manifest_bundle_invalid');
        if (format !== 'symlink' && format !== 'workspace-bundle-v1' && !relative(entry.objectPath)) throw Error('manifest_object_missing');
        source.logicalBytes += entry.byteLength || 0;
      }
      source.validation = 'manifest-verified-payloads-unverified';
      source.objectGeneration = String(objectGeneration);
      source.fileCount = manifest.files.length; source.formats = counts;
      knownLogicalBytes += source.logicalBytes;
      if (workspace.agentRuntimeGeneration && pointer.generation !== workspace.agentRuntimeGeneration) blockers.add('checkpoint_predates_current_runtime_generation');
      blockers.add('checkpoint_payload_verification_required');
    } catch (error) {
      // Fixed categories only: no GCS errors, file names or credential values.
      const allowed = new Set(['invalid_reference', 'manifest_checksum_mismatch', 'manifest_identity_or_schema_mismatch', 'manifest_entry_invalid', 'manifest_storage_unsupported', 'manifest_bundle_invalid', 'manifest_object_missing', 'manifest_object_not_found', 'manifest_access_denied', 'manifest_size_mismatch']);
      source.validation = allowed.has(error.message) ? error.message : 'manifest_unavailable_or_invalid';
      blockers.add(`${kind}_manifest_not_verified`);
    }
  }
  if (!workspace.agentRuntimeWorkspaceFiles && !workspace.sharedStorage?.bucketName) {
    formats.add('legacy-flat-prefix');
    blockers.add('flat_prefix_and_internal_archives_not_inventoried');
  }
  // A checkpoint is not a complete machine export. These sources need their own
  // inventory and quiesced capture even when all manifest checks above pass.
  blockers.add('home_browser_owner_tools_uploads_and_private_git_require_inventory');
  blockers.add('unpublished_captures_and_live_only_state_require_reconciliation');
  blockers.add('cost_and_downtime_estimates_pending');
  return {workspaceId, ownerUid: workspace.ownerUid || null,
    classification: ssh ? 'excluded-ssh' : n64 ? 'excluded-n64' : !sessions.length ? 'never-started' : failedStop ? 'stop-failed' : live.length ? 'active' : 'inactive',
    sessionCount: sessions.length, activeSessionIds: live.map(s => s.id),
    sourceGeneration: workspace.agentRuntimeGeneration || null, formats: [...formats].sort(), sources,
    knownLogicalBytes, requiredDiskSizeGb: null,
    diskLowerBoundGb: Math.max(64, Math.ceil(knownLogicalBytes * 1.3 / (1024 ** 3))),
    estimateScope: 'manifest logical bytes only; archives, shared trees and uncheckpointed data excluded',
    pathMapping: {workspace: '/var/lib/mapache/workspace/workspace', home: '/var/lib/mapache/workspace/home',
      browser: '/var/lib/mapache/workspace/browser/profile', agent: '/var/lib/mapache/workspace/agent',
      uploads: '/var/lib/mapache/workspace/uploads', credentials: 'rematerialize selected references through brokers'},
    readyForCutover: false, blockers: [...blockers].sort()};
}
