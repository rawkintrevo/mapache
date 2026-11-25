import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {assertBucketMetadata} = require('../../functions/workspaceBucketAccess.service.js');
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = reason => { throw Error(reason); };

// Read-only provenance checks. Do not call the legacy ensure/validate service:
// that service may repair IAM, which inventory must never mutate.
export async function inspectSharedTreeAuthority({workspaceId, workspace, readBucketMetadata, readJsonObject}) {
  let phase = 'descriptor';
  try {
    const descriptor = workspace.sharedStorage;
    if (!workspace.ownerUid || !workspaceId || descriptor?.projectId !== 'pi-agents-cloud' ||
        !/^[0-9]+$/.test(String(descriptor.projectNumber || '')) || !/^[A-Za-z0-9_-]{1,160}$/.test(descriptor.storageGeneration || '') ||
        descriptor.treePrefix !== `trees/${descriptor.storageGeneration}` ||
        !['.mapache-internal/workspace-ready.json', '.mapahce-internal/workspace-ready.json'].includes(descriptor.readyMarker) ||
        descriptor.bucketName !== `mpw-${descriptor.projectNumber}-${digest(workspaceId).slice(0, 24)}`) fail('shared_descriptor_invalid');
    phase = 'bucket';
    const metadata = await readBucketMetadata(descriptor.bucketName);
    try { assertBucketMetadata(metadata, {...descriptor, workspaceId, ownerUid: workspace.ownerUid}); }
    catch { fail('shared_bucket_identity_invalid'); }
    if (metadata.hierarchicalNamespace?.enabled !== true) fail('shared_bucket_layout_unsupported');
    phase = 'marker';
    const markerObject = await readJsonObject({bucketName: descriptor.bucketName,
      objectPath: `${descriptor.treePrefix}/${descriptor.readyMarker}`, maxBytes: 65536});
    const parse = (object, maxBytes) => {
      if (!Buffer.isBuffer(object.content) || object.content.length > maxBytes || !/^[1-9][0-9]*$/.test(String(object.generation || ''))) fail('shared_json_invalid');
      try { return JSON.parse(object.content); } catch { fail('shared_json_invalid'); }
    };
    const marker = parse(markerObject, 65536);
    if (marker.kind !== 'mapache-shared-workspace-ready' || marker.state !== 'ready' ||
        marker.storageGeneration !== descriptor.storageGeneration || marker.operationId !== descriptor.storageGeneration) fail('shared_ready_marker_mismatch');
    const evidence = {markerGeneration: String(markerObject.generation), markerSha256: digest(markerObject.content),
      hierarchicalFoldersRequireInventory: true, scope: 'bucket ownership and original import provenance only; current objects/folders and live writers unverified'};
    phase = 'control';
    let controlObject;
    try { controlObject = await readJsonObject({bucketName: descriptor.bucketName,
      objectPath: `.mapache-internal/shared-workspace-imports/${descriptor.storageGeneration}/control.json`, maxBytes: 16 * 1024 * 1024}); }
    catch (error) { if (Number(error.code) === 404) return {status: 'marker-verified-control-missing', ...evidence}; throw error; }
    const control = parse(controlObject, 16 * 1024 * 1024);
    if (control.version !== 1 || control.kind !== 'mapache-shared-workspace-import' || control.state !== 'ready' ||
        control.source?.workspaceId !== workspaceId || control.operationId !== descriptor.storageGeneration ||
        control.storageGeneration !== descriptor.storageGeneration || control.treePrefix !== descriptor.treePrefix || !Array.isArray(control.objects)) fail('shared_control_mismatch');
    return {status: 'marker-and-control-verified', ...evidence, controlGeneration: String(controlObject.generation),
      controlSha256: digest(controlObject.content), originalImportObjects: control.objects.length, hasPrivateGitSeed: Boolean(control.gitSeed)};
  } catch (error) {
    const allowed = new Set(['shared_descriptor_invalid', 'shared_bucket_identity_invalid', 'shared_bucket_layout_unsupported',
      'shared_json_invalid', 'shared_ready_marker_mismatch', 'shared_control_mismatch']);
    return {status: 'blocked', reason: allowed.has(error.message) ? error.message : Number(error.code) === 404 ? `shared_${phase}_not_found` :
      [401, 403].includes(Number(error.code)) ? 'shared_source_access_denied' : 'shared_source_unavailable'};
  }
}
