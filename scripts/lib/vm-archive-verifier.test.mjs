import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import tar from 'tar-stream';
import {verifyGzipTar} from './vm-archive-verifier.mjs';
async function archive(members) {
  const pack = tar.pack(); const chunks = [];
  const collect = (async () => { for await (const chunk of pack) chunks.push(chunk); })();
  for (const [header, value = ''] of members) pack.entry(header, value);
  pack.finalize(); await collect;
  return gzipSync(Buffer.concat(chunks));
}
function verify(bytes, options = {}) {
  return verifyGzipTar({stream: Readable.from([bytes.subarray(0, 9), bytes.subarray(9)]), byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), maxCompressedBytes: 1000000, maxExpandedBytes: 1000000, maxEntries: 100, ...options});
}
test('valid gzip archive is hashed and parsed without retaining member names or contents', async () => {
  const bytes = await archive([[{name: './', type: 'directory'}], [{name: './Default/', type: 'directory'}],
    [{name: './Default/private-cookie-data'}, 'private-content'], [{name: './alias', type: 'symlink', linkname: 'Default/private-cookie-data'}],
    [{name: './hard', type: 'link', linkname: './Default/private-cookie-data'}]]);
  const result = await verify(bytes);
  assert.equal(result.status, 'verified'); assert.equal(result.entries, 5);
  assert.deepEqual(result.types, {directory: 2, file: 1, symlink: 1, link: 1});
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('traversal, absolute paths, unsafe link ancestry, hardlink cycles and special files fail', async () => {
  for (const members of [ [[{name: '../escape'}, 'x']], [[{name: '/absolute'}, 'x']],
    [[{name: 'alias', type: 'symlink', linkname: '../escape'}]],
    [[{name: 'alias', type: 'symlink', linkname: 'target'}], [{name: 'alias/child'}, 'x']],
    [[{name: 'a', type: 'link', linkname: 'b'}], [{name: 'b', type: 'link', linkname: 'a'}]],
    [[{name: 'special', type: 'fifo'}]], [[{name: 'same'}, 'x'], [{name: 'same'}, 'x']] ]) {
    assert.equal((await verify(await archive(members))).status, 'blocked');
  }
});
test('compressed/expanded/entry limits and checksum errors cannot report a verified archive', async () => {
  const bytes = await archive([[{name: 'file'}, 'x'.repeat(10000)]]);
  for (const options of [{maxCompressedBytes: 1}, {maxExpandedBytes: 512}, {maxEntries: 0}, {sha256: 'a'.repeat(64)}, {byteLength: bytes.length + 1}]) {
    assert.equal((await verify(bytes, options)).status, 'blocked');
  }
  assert.equal((await verify(bytes.subarray(0, bytes.length - 8))).status, 'blocked');
});
