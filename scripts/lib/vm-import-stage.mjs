import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(Error(code), {code}); };
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function plainDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) fail('import_stage_directory_invalid');
}
async function readPlain(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail('import_stage_record_invalid');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function publishRecord(directory, name, bytes) {
  const temporary = path.join(directory, `.partial-${randomUUID()}`);
  const target = path.join(directory, name);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    try { await fs.link(temporary, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await readPlain(target, bytes.length)).equals(bytes)) fail('import_stage_identity_mismatch');
    await syncDirectory(directory);
  } finally { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
}

// Local staging only. The coordinator must supply a trusted, exclusively mounted
// new disk: this module does not establish Compute ownership or source authority.
export async function openImportStage({root, ownerUid, workspaceId, operationId, sourcePlanSha256}) {
  if (![ownerUid, workspaceId, operationId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512) ||
      !validHash(sourcePlanSha256) || !path.isAbsolute(root || '')) fail('import_stage_identity_invalid');
  root = path.resolve(root);
  // Resolve the parent before creating anything; refuse ancestor symlink aliases.
  if (await fs.realpath(path.dirname(root)) !== path.dirname(root)) fail('import_stage_path_invalid');
  const identity = Buffer.from(JSON.stringify({schemaVersion: 1, ownerUid, workspaceId, operationId, sourcePlanSha256}));
  let created = false;
  try { await fs.mkdir(root, {mode: 0o700}); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await plainDirectory(root);
  if (!created) {
    // Never adopt an unknown populated directory, even if its files look valid.
    if (!(await readPlain(path.join(root, 'identity.json'), identity.length)).equals(identity)) fail('import_stage_identity_mismatch');
  } else {
    await publishRecord(root, 'identity.json', identity);
    await syncDirectory(path.dirname(root));
  }
  for (const child of ['objects', 'journal']) {
    try { await fs.mkdir(path.join(root, child), {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await plainDirectory(path.join(root, child));
  }
  await syncDirectory(root);
  return {root, identitySha256: digest(identity)};
}

async function verifyObject(file, descriptor) {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== descriptor.byteLength || (stat.mode & 0o777) !== 0o600) fail('import_stage_destination_changed');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({autoClose: false})) hash.update(chunk);
    if (hash.digest('hex') !== descriptor.sha256) fail('import_stage_destination_changed');
    return true;
  } finally { await handle.close(); }
}

export async function stageImportObject({stage, descriptor, openSource, maxBytes}) {
  const {bucketName, objectPath, generation, byteLength, sha256} = descriptor || {};
  if (![bucketName, objectPath].every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')) ||
      typeof generation !== 'string' || !/^[1-9][0-9]*$/.test(generation) || !validHash(sha256) ||
      !Number.isSafeInteger(byteLength) || byteLength < 0 || !Number.isSafeInteger(maxBytes) || byteLength > maxBytes) fail('import_stage_descriptor_invalid');
  const canonical = {bucketName, objectPath, generation, byteLength, sha256};
  const record = Buffer.from(JSON.stringify({identitySha256: stage.identitySha256, source: canonical}));
  const key = digest(record);
  const objects = path.join(stage.root, 'objects');
  const journal = path.join(stage.root, 'journal');
  await plainDirectory(stage.root); await plainDirectory(objects); await plainDirectory(journal);
  if (digest(await readPlain(path.join(stage.root, 'identity.json'), 8192)) !== stage.identitySha256) fail('import_stage_identity_mismatch');
  await publishRecord(journal, `${key}.json`, record);
  const destination = path.join(objects, key);
  if (await verifyObject(destination, canonical)) return {key, byteLength, reused: true};
  const temporary = path.join(objects, `.partial-${randomUUID()}`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  let stream;
  try {
    const source = await openSource(canonical);
    stream = source.stream;
    if (String(source.generation) !== generation) fail('import_stage_source_changed');
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > byteLength) fail('import_stage_size_mismatch');
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    if (bytes !== byteLength) fail('import_stage_size_mismatch');
    if (hash.digest('hex') !== sha256) fail('import_stage_checksum_mismatch');
    await handle.sync(); await handle.close();
    // link() publishes without replacing any existing destination, including a
    // concurrently completed copy. Rename would silently overwrite that file.
    try { await fs.link(temporary, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await verifyObject(destination, canonical);
    await syncDirectory(objects);
    return {key, byteLength, reused: false};
  } finally {
    stream?.destroy();
    await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
