import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {assembleMergedImport, normalizePrefixCapture} from './vm-import-merge.mjs';
import {plainDirectory, publishRecord, readPlain, syncDirectory} from './vm-import-stage.mjs';
import {verifyImportSubtree} from './vm-import-tree.mjs';

const require = createRequire(import.meta.url);
const {workspaceDiskName} = require('../../functions/runtimeProvider.helpers.js');
const {DISK_MARKER_NAME, retainedDiskMarker} = require('../../session-runner/lib/retainedDiskStorage.js');
const stageName = '.mapache-import-stage';
const durableRoots = new Set(['home', 'workspace', 'agent', 'browser', 'uploads']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Error(code); };

export async function verifyDiskMount(root, device, {readOnly = false} = {}) {
  const unescape = field => field.replace(/\\([0-7]{3})/g, (_, number) => String.fromCharCode(parseInt(number, 8)));
  const mounts = (await fs.readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n').map(line => {
    const [mount, filesystem] = line.split(' - ');
    const [, , deviceNumber, base, target, options] = mount.split(' ');
    const [type, source, superOptions] = filesystem.split(' ');
    return {deviceNumber, base: unescape(base), target: unescape(target), options, type, source: unescape(source), superOptions};
  });
  const exact = mounts.filter(mount => mount.target === root);
  const mount = exact[0];
  const mode = readOnly ? 'ro' : 'rw';
  if (exact.length !== 1 || mount.base !== '/' || mount.type !== 'ext4' ||
      !mount.options.split(',').includes(mode) || !mount.superOptions.split(',').includes(mode) ||
      mounts.some(item => item !== mount && (item.deviceNumber === mount.deviceNumber ||
        item.target.startsWith(root + '/')))) fail('disk_import_mount_invalid');
  const [mounted, expected] = await Promise.all([fs.stat(mount.source), fs.stat(device)]);
  if (!mounted.isBlockDevice() || !expected.isBlockDevice() || mounted.rdev !== expected.rdev) fail('disk_import_device_mismatch');
  if (readOnly && (await fs.readFile('/sys/dev/block/' + mount.deviceNumber + '/ro', 'utf8')).trim() !== '1') {
    fail('disk_import_device_writable');
  }
}

async function readOptional(file, limit) {
  try { return await readPlain(file, limit); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function plannedRoots(entries) {
  const roots = new Set();
  for (const entry of entries) {
    const [top, ...children] = entry.path.split('/');
    const safe = segment => segment && segment !== '.' && segment !== '..' && !/[\\\0]/.test(segment);
    if (!durableRoots.has(top) || !children.every(safe) || (!children.length && entry.kind !== 'directory')) fail('disk_import_path_disallowed');
    if (entry.kind === 'hardlink' && (entry.target.split('/')[0] !== top || !entry.target.split('/').every(safe))) {
      fail('disk_import_cross_root_hardlink');
    }
    roots.add(top);
  }
  return roots;
}

function diskReceipt(intent, roots, entries, destination) {
  return {schemaVersion: 1, ...intent, directoriesPublished: roots.size, selectedEntries: entries.length,
    ...(destination ? {destination} : {}), scope: 'selected recovery trees verified on the retained disk'};
}

async function checkImportedDisk(config, checkMount, readOnly) {
  const {mountRoot, ownerUid, workspaceId, generation, operationId} = config;
  if (typeof mountRoot !== 'string' || !path.isAbsolute(mountRoot) || mountRoot === '/' ||
      await fs.realpath(mountRoot) !== mountRoot || !Number.isSafeInteger(generation) || generation < 1 ||
      ![ownerUid, workspaceId, operationId].every(value => typeof value === 'string' && value)) fail('disk_import_config_invalid');
  const diskName = workspaceDiskName(workspaceId);
  const device = '/dev/disk/by-id/google-' + diskName;
  await checkMount(mountRoot, device, {readOnly});
  const marker = JSON.parse(await readPlain(path.join(mountRoot, DISK_MARKER_NAME), 8192));
  const expected = retainedDiskMarker({workspaceId, ownerUid, generation, operationId});
  if (Object.entries(expected).some(([key, value]) => marker[key] !== value)) fail('disk_import_identity_mismatch');
  return {diskName, device};
}

export async function readRetainedDiskReceipt(config, {checkMount = verifyDiskMount} = {}) {
  const {mountRoot, ownerUid, workspaceId, generation, operationId} = config;
  const prefixCapture = normalizePrefixCapture(config.prefixCapture);
  if (!prefixCapture) fail('disk_import_capture_required');
  const {diskName} = await checkImportedDisk(config, checkMount, true);
  if (config.diskName !== diskName) fail('disk_import_identity_mismatch');
  const root = path.join(mountRoot, stageName);
  await plainDirectory(root);
  const planBytes = await readPlain(path.join(root, 'merge-plan.json'), 64 * 1024 * 1024);
  const intent = JSON.parse(await readPlain(path.join(root, 'disk-import-intent.json'), 8192));
  const receipt = JSON.parse(await readPlain(path.join(root, 'disk-import-receipt.json'), 8192));
  const plan = JSON.parse(planBytes);
  if (plan.schemaVersion !== 1 || plan.ownerUid !== ownerUid || plan.workspaceId !== workspaceId ||
      !Array.isArray(plan.entries) || digest(planBytes) !== intent.sourcePlanSha256 ||
      !/^[a-f0-9]{64}$/.test(intent.configSha256 || '')) fail('disk_import_plan_changed');
  if (!isDeepStrictEqual(normalizePrefixCapture(plan.prefixCapture), prefixCapture) ||
      !isDeepStrictEqual(plan.prefixCapture, intent.prefixCapture)) fail('disk_import_capture_changed');
  const entries = plan.entries;
  const roots = plannedRoots(entries);
  const allowed = new Set([DISK_MARKER_NAME, 'lost+found', stageName, ...roots]);
  const expected = diskReceipt({configSha256: intent.configSha256, sourcePlanSha256: intent.sourcePlanSha256,
    prefixCapture: plan.prefixCapture}, roots, entries, {ownerUid, workspaceId, generation, operationId, diskName});
  if (!roots.size || !isDeepStrictEqual(receipt, expected)) fail('disk_import_receipt_invalid');
  const tree = path.join(root, 'tree');
  await plainDirectory(tree);
  if ((await fs.readdir(tree)).length || (await fs.readdir(mountRoot)).some(name => !allowed.has(name))) {
    fail('disk_import_destination_changed');
  }
  for (const name of roots) await verifyImportSubtree(mountRoot, entries, name);
  return expected;
}

async function requireCapacity(root, entries) {
  const stat = await fs.statfs(root, {bigint: true});
  const block = stat.bsize;
  let fileBlocks = 0n;
  let entryCount = 0n;
  for (const entry of entries) {
    entryCount += BigInt(entry.path.split('/').length);
    if (entry.kind === 'file') fileBlocks += (BigInt(entry.byteLength) + block - 1n) / block;
  }
  // Budget for both copies, metadata and write-ahead records. ENOSPC remains
  // possible and keeps the import incomplete when the actual allocation fails.
  if (stat.bavail < 2n * fileBlocks + 8n * entryCount + 128n ||
      stat.ffree < 4n * entryCount + 32n) fail('disk_import_capacity_insufficient');
}

// Run on a maintenance host with the positively identified disk mounted and
// exclusive writer access. The disk was initialized by its provisioning step.
export async function importToRetainedDisk(config, {checkMount = verifyDiskMount, afterPublish} = {}) {
  const {mountRoot, ownerUid, workspaceId, generation, operationId, sources, maxBytes} = config;
  const prefixCapture = normalizePrefixCapture(config.prefixCapture);
  const {diskName, device} = await checkImportedDisk(config, checkMount, false);

  const root = path.join(mountRoot, stageName);
  const initialNames = await fs.readdir(mountRoot);
  const stageExists = initialNames.includes(stageName);
  if (stageExists) await plainDirectory(root);
  const intentName = 'disk-import-intent.json';
  const intentPath = path.join(root, intentName);
  const intentBytes = await readOptional(intentPath, 8192);
  const configSha256 = digest(JSON.stringify({device, ownerUid, workspaceId, generation, operationId, sources, maxBytes, prefixCapture}));
  let intent;
  if (intentBytes) {
    intent = JSON.parse(intentBytes);
    if (intent.configSha256 !== configSha256) fail('disk_import_operation_changed');
  } else {
    const allowed = new Set([DISK_MARKER_NAME, 'lost+found', stageName]);
    if (initialNames.some(name => !allowed.has(name))) fail('disk_import_destination_populated');
    const merged = await assembleMergedImport({root, ownerUid, workspaceId, operationId, sources, maxBytes, prefixCapture}, {
      beforeStage: async ({document}) => {
        plannedRoots(document.entries);
        if (!stageExists) await requireCapacity(mountRoot, document.entries);
      },
    });
    intent = {configSha256, sourcePlanSha256: merged.sourcePlanSha256,
      ...(merged.prefixCapture ? {prefixCapture: merged.prefixCapture} : {})};
    await publishRecord(root, intentName, Buffer.from(JSON.stringify(intent)));
  }
  const planBytes = await readPlain(path.join(root, 'merge-plan.json'), 64 * 1024 * 1024);
  if (digest(planBytes) !== intent.sourcePlanSha256) fail('disk_import_plan_changed');
  const {entries, prefixCapture: mergedCapture} = JSON.parse(planBytes);
  if (JSON.stringify(normalizePrefixCapture(mergedCapture)) !== JSON.stringify(prefixCapture) ||
      JSON.stringify(mergedCapture) !== JSON.stringify(intent.prefixCapture)) fail('disk_import_capture_changed');
  const roots = plannedRoots(entries);
  const tree = path.join(root, 'tree');
  await plainDirectory(tree);
  const staged = new Set(await fs.readdir(tree));
  const installed = new Set(await fs.readdir(mountRoot));
  const allowed = new Set([DISK_MARKER_NAME, 'lost+found', stageName, ...roots]);
  if ([...installed].some(name => !allowed.has(name)) ||
      [...staged].some(name => !roots.has(name)) ||
      [...roots].some(name => staged.has(name) === installed.has(name))) fail('disk_import_destination_changed');
  for (const name of roots) {
    await verifyImportSubtree(staged.has(name) ? tree : mountRoot, entries, name);
  }
  for (const name of staged) {
    // Both paths are on the same disk. Exclusive maintenance access ensures
    // the checked destination stays absent until rename completes.
    await fs.rename(path.join(tree, name), path.join(mountRoot, name));
    await syncDirectory(tree);
    await syncDirectory(mountRoot);
    await afterPublish?.();
  }
  for (const name of roots) await verifyImportSubtree(mountRoot, entries, name);
  const receipt = diskReceipt(intent, roots, entries, prefixCapture ? {ownerUid, workspaceId, generation, operationId, diskName} : undefined);
  await publishRecord(root, 'disk-import-receipt.json', Buffer.from(JSON.stringify(receipt)));
  return receipt;
}
