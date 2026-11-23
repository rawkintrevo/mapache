import {createHash} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import tar from 'tar-stream';

function archivePath(value) {
  if (typeof value !== 'string' || !value || /[\\\0]/.test(value) || path.posix.isAbsolute(value)) throw Error('archive_path_invalid');
  const normalized = path.posix.normalize(value).replace(/\/$/, '');
  if (normalized === '..' || normalized.startsWith('../')) throw Error('archive_path_invalid');
  return normalized;
}

// Parse in memory without creating files, links or directories. File bodies are
// drained through bounded streams; only header metadata is retained for checks.
export async function verifyGzipTar({stream, byteLength, sha256, maxCompressedBytes, maxExpandedBytes, maxEntries}) {
  let compressedBytes = 0; let expandedBytes = 0; let fileBytes = 0;
  const digest = createHash('sha256'); const entries = new Map(); const counts = {};
  try {
    if (![byteLength, maxCompressedBytes, maxExpandedBytes, maxEntries].every(Number.isSafeInteger) ||
        byteLength < 0 || maxCompressedBytes < byteLength || maxExpandedBytes < 1 || maxEntries < 1 || !/^[a-f0-9]{64}$/.test(sha256 || '')) throw Error('archive_budget_or_descriptor_invalid');
    const compressed = new Transform({transform(chunk, _encoding, done) {
      compressedBytes += chunk.length;
      if (compressedBytes > byteLength) return done(Error('archive_size_mismatch'));
      digest.update(chunk); done(null, chunk);
    }});
    const expanded = new Transform({transform(chunk, _encoding, done) {
      expandedBytes += chunk.length;
      if (expandedBytes > maxExpandedBytes) return done(Error('archive_expansion_limit'));
      done(null, chunk);
    }});
    const extract = tar.extract();
    extract.on('entry', (header, body, next) => {
      body.on('error', error => extract.destroy(error));
      try {
        const name = archivePath(header.name);
        if (!['file', 'directory', 'symlink', 'link'].includes(header.type) || (name === '.' && header.type !== 'directory')) throw Error('archive_type_unsupported');
        if (entries.size >= maxEntries) throw Error('archive_entry_limit');
        if (entries.has(name)) throw Error('archive_duplicate_path');
        if (!Number.isSafeInteger(header.size) || header.size < 0 || (header.type !== 'file' && header.size !== 0)) throw Error('archive_size_invalid');
        let target;
        if (header.type === 'symlink') {
          if (!header.linkname || path.posix.isAbsolute(header.linkname) || /[\\\0]/.test(header.linkname)) throw Error('archive_link_invalid');
          target = archivePath(path.posix.join(path.posix.dirname(name), header.linkname));
        } else if (header.type === 'link') target = archivePath(header.linkname);
        entries.set(name, {type: header.type, target});
        counts[header.type] = (counts[header.type] || 0) + 1;
        fileBytes += header.size;
        if (!Number.isSafeInteger(fileBytes) || fileBytes > maxExpandedBytes) throw Error('archive_expansion_limit');
        body.on('end', next); body.resume();
      } catch (error) { extract.destroy(error); }
    });
    await pipeline(stream, compressed, createGunzip(), expanded, extract);
    if (compressedBytes !== byteLength) throw Error('archive_size_mismatch');
    if (digest.digest('hex') !== sha256) throw Error('archive_checksum_mismatch');
    for (const [name, entry] of entries) {
      let parent = path.posix.dirname(name);
      while (parent !== '.') {
        if (entries.has(parent) && entries.get(parent).type !== 'directory') throw Error('archive_non_directory_ancestor');
        parent = path.posix.dirname(parent);
      }
      if (entry.type === 'link') {
        const visited = new Set([name]); let target = entry.target;
        while (entries.get(target)?.type === 'link' && !visited.has(target)) { visited.add(target); target = entries.get(target).target; }
        if (visited.has(target) || entries.get(target)?.type !== 'file') throw Error('archive_hardlink_invalid');
      }
    }
    return {status: 'verified', compressedBytes, expandedBytes, fileBytes, entries: entries.size, types: counts,
      scope: 'gzip/tar integrity and safe member layout; no extraction or application-level restore performed'};
  } catch (error) {
    stream.destroy?.();
    const allowed = new Set(['archive_budget_or_descriptor_invalid', 'archive_size_mismatch', 'archive_expansion_limit', 'archive_path_invalid',
      'archive_type_unsupported', 'archive_entry_limit', 'archive_duplicate_path', 'archive_size_invalid', 'archive_link_invalid',
      'archive_checksum_mismatch', 'archive_non_directory_ancestor', 'archive_hardlink_invalid']);
    return {status: 'blocked', reason: allowed.has(error.message) ? error.message : 'archive_stream_or_format_invalid'};
  }
}
