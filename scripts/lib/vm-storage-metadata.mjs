import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {validateDescriptor} = require('../../session-runner/lib/chromeProfileSeed.service.js');
const safePrefix = value => typeof value === 'string' && value.length > 0 && !/[\\\0\r\n]/.test(value) && !value.split('/').some(p => !p || p === '.' || p === '..');
const safeBucket = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(value);

export function storageCandidates({workspace, sessions, defaultBucket, toolsBucket}) {
  const candidates = new Map(); const unresolved = new Set();
  const add = (role, bucketName, prefix) => {
    if (!safeBucket(bucketName) || !safePrefix(prefix)) { unresolved.add(`${role}_descriptor_unresolved`); return; }
    const key = `${bucketName}/${prefix}`;
    const candidate = candidates.get(key) || {bucketName, prefix, roles: []};
    if (!candidate.roles.includes(role)) candidate.roles.push(role);
    candidates.set(key, candidate);
  };
  const bucket = workspace.bucket || workspace.workspaceStorageBucket || defaultBucket;
  const prefix = workspace.storagePrefix || workspace.workspaceStoragePrefix;
  add('workspace', bucket, prefix);
  const policy = workspace.homePolicy || {};
  if (policy.mode !== 'ephemeral') {
    const rawHomePrefix = policy.storagePrefix || (prefix && `${prefix}/.mapache-internal/home`);
    const homePrefix = typeof rawHomePrefix === 'string' ? rawHomePrefix.replace(/(^|\/)\.mapahce-internal\//, '$1.mapache-internal/') : rawHomePrefix;
    add('home', policy.bucket || bucket, homePrefix);
    if (typeof homePrefix === 'string') add('legacy-home', policy.bucket || bucket, homePrefix.replace(/(^|\/)\.mapache-internal\//, '$1.mapahce-internal/'));
  }
  if (prefix) {
    for (const internal of ['.mapache-internal', '.mapahce-internal']) {
      add('browser-archive', bucket, `${prefix}/${internal}/chrome`);
      add('browser-seed', bucket, `${prefix}/${internal}/chrome-profile-seeds/v1`);
      add('uploads', bucket, `${prefix}/${internal}/uploads`);
    }
  }
  for (const session of sessions) {
    if (session.workspaceStoragePrefix) add('session-workspace', session.workspaceStorageBucket || session.bucket || bucket, session.workspaceStoragePrefix);
    if (session.homeStoragePrefix) add('session-home', session.homeStorageBucket || bucket, session.homeStoragePrefix);
  }
  if (workspace.sharedStorage) add('shared-tree', workspace.sharedStorage.bucketName,
      workspace.sharedStorage.treePrefix || (workspace.sharedStorage.storageGeneration && `trees/${workspace.sharedStorage.storageGeneration}`));
  if (typeof workspace.ownerUid === 'string' && workspace.ownerUid) add('owner-tools', toolsBucket,
      `mapache-user-tools/${createHash('sha256').update(workspace.ownerUid).digest('hex')}/.mapache-internal/tools`);
  else unresolved.add('owner_tools_owner_unresolved');
  return {candidates: [...candidates.values()], unresolved: [...unresolved]};
}

function category(name, roles) {
  if (!name || name.endsWith('/') || /(?:^|\/)\.mapa(?:ch|hc)e-directory$/.test(name)) return 'directory-marker';
  if (/(?:^|\/)workspace-(?:pi-)?git\.tar\.gz$/.test(name)) return 'private-git-archive';
  if (roles.includes('browser-seed')) return name === 'current.json' ? 'browser-seed-pointer' : 'browser-seed-object';
  if (roles.includes('browser-archive')) return 'browser-archive';
  if (roles.includes('uploads')) return 'uploads';
  if (roles.includes('owner-tools')) return 'owner-tool-object';
  if (roles.some(role => ['home', 'legacy-home', 'session-home'].includes(role))) return /\.tar(?:\.gz)?$/.test(name) ? 'home-archive' : 'home-source-object';
  const internal = name.match(/(?:^|\/)(\.mapache-internal|\.mapahce-internal)\/(.*)$/);
  const rest = internal?.[2] || name;
  if (internal && /^home\/.*\.tar(?:\.gz)?$/.test(rest)) return 'home-archive';
  if (/^chrome-profile-seeds\//.test(rest)) return rest.endsWith('/current.json') ? 'browser-seed-pointer' : 'browser-seed-object';
  if (/^chrome\//.test(rest) || /(?:^|\/)chrome-profile\.tar\.gz$/.test(rest)) return 'browser-archive';
  if (/^uploads\//.test(rest)) return 'uploads';
  if (/^automation-outputs\//.test(rest)) return 'automation-output';
  if (/^agent-snapshots\//.test(rest)) return /\/staging\//.test(rest) ? 'checkpoint-staging' : 'checkpoint-object';
  return internal ? 'other-internal' : 'workspace-or-tool-object';
}

export async function inventoryStorageMetadata({candidates, unresolved, listPage, maxObjects, inspectBrowserSeed}) {
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1) throw Error('invalid_metadata_budget');
  let remaining = maxObjects;
  const sources = [];
  for (const candidate of candidates) {
    const source = {roles: candidate.roles, bucketName: candidate.bucketName,
      prefixSha256: createHash('sha256').update(candidate.prefix).digest('hex'),
      status: 'not-scanned', objects: 0, storedBytes: 0, categories: {}, legacyInternalObjects: 0};
    sources.push(source);
    const evidence = createHash('sha256'); const seenTokens = new Set();
    let pageToken;
    try {
      do {
        if (!remaining) { source.status = 'budget-exhausted'; break; }
        const limit = Math.min(1000, remaining);
        const page = await listPage({...candidate, prefix: `${candidate.prefix}/`, pageToken, limit});
        if (!Array.isArray(page.objects) || page.objects.length > limit) throw Error('invalid_metadata_page');
        for (const object of page.objects) {
          if (typeof object.name !== 'string' || !object.name.startsWith(`${candidate.prefix}/`) ||
              !/^(0|[1-9]\d*)$/.test(String(object.size)) || !Number.isSafeInteger(Number(object.size)) || !/^[1-9]\d*$/.test(String(object.generation || ''))) throw Error('invalid_object_metadata');
          const relative = object.name.slice(candidate.prefix.length + 1);
          const kind = category(relative, candidate.roles);
          const aggregate = source.categories[kind] ||= {objects: 0, storedBytes: 0};
          aggregate.objects++; aggregate.storedBytes += Number(object.size);
          source.objects++; source.storedBytes += Number(object.size); remaining--;
          if (!Number.isSafeInteger(source.storedBytes)) throw Error('invalid_object_metadata');
          if (/(?:^|\/)(?:\.mapache-internal|\.mapahce-internal)\//.test(object.name)) source.legacyInternalObjects++;
          evidence.update(JSON.stringify([object.name, String(object.generation), String(object.size), object.crc32c || null, object.md5Hash || null]));
        }
        pageToken = page.nextPageToken;
        if (pageToken && seenTokens.has(pageToken)) throw Error('metadata_pagination_stalled');
        if (pageToken) seenTokens.add(pageToken);
        if (!pageToken) source.status = 'listed-payloads-unverified';
      } while (pageToken);
      source.metadataEvidenceSha256 = evidence.digest('hex');
      if (source.status === 'listed-payloads-unverified' && candidate.roles.includes('browser-seed') && source.categories['browser-seed-pointer'] && inspectBrowserSeed) {
        source.currentSeed = await inspectBrowserSeed(candidate);
      }
    } catch (error) {
      source.status = 'blocked';
      source.reason = [401, 403].includes(Number(error.code)) ? 'storage_access_denied' : Number(error.code) === 404 ? 'storage_source_not_found' :
        ['invalid_metadata_page', 'invalid_object_metadata', 'metadata_pagination_stalled'].includes(error.message) ? error.message : 'storage_listing_unavailable';
    }
  }
  return {sources, unresolved, maxObjects, listedObjects: maxObjects - remaining, sourceTotalsMayOverlap: true,
    scope: 'current object metadata only; no archive extraction, content verification, source authority selection or consistent filesystem snapshot'};
}

export async function inspectBrowserSeedMetadata({workspaceId, workspacePrefix, bucketName, readPointer, readObjectMetadata, verifyArchive}) {
  try {
    const {content, generation} = await readPointer();
    if (content.length > 65536) throw Error('browser_seed_pointer_too_large');
    const descriptor = JSON.parse(content.toString('utf8'));
    try { validateDescriptor(descriptor, {workspaceId, prefix: workspacePrefix, bucketName}); }
    catch { throw Error('browser_seed_descriptor_invalid'); }
    const metadata = await readObjectMetadata({bucketName, objectPath: descriptor.objectPath, generation: descriptor.objectGeneration});
    if (String(metadata.generation) !== String(descriptor.objectGeneration) || Number(metadata.size) !== descriptor.byteLength) throw Error('browser_seed_object_mismatch');
    const archive = verifyArchive ? await verifyArchive(descriptor) : undefined;
    return {status: archive?.status === 'verified' ? 'descriptor-and-archive-verified' : 'descriptor-verified-payload-unverified', pointerGeneration: String(generation),
      ...(archive ? {archive} : {}),
      seedVersion: descriptor.seedVersion, objectGeneration: String(descriptor.objectGeneration), byteLength: descriptor.byteLength, capturedAt: descriptor.capturedAt};
  } catch (error) {
    return {status: 'blocked', reason: ['browser_seed_pointer_too_large', 'browser_seed_descriptor_invalid', 'browser_seed_object_mismatch'].includes(error.message) ? error.message :
      Number(error.code) === 404 ? 'browser_seed_object_not_found' : [401, 403].includes(Number(error.code)) ? 'browser_seed_access_denied' : 'browser_seed_unavailable'};
  }
}
