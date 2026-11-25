"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createVmMigrationStorageObserver} = require("./vmMigrationStorageObservation.service");

const prefix = "workspaces/owner/workspace";
const bucket = "default-bucket";
const identity = {ownerUid: "owner", workspace: {storagePrefix: prefix, bucket, homePolicy: {mode: "persistent"}}, sessions: []};
const record = (name, generation = "100", metageneration = "1") => ({
  name: prefix + "/" + name, generation, metageneration, size: "1", crc32c: "valid",
});
const archive = record(".mapache-internal/home/home.tar.gz");
const run = listPage => createVmMigrationStorageObserver({defaultBucket: bucket, listPage});

test("stable generations across differently ordered pages produce identical evidence", async () => {
  let reads = 0;
  const result = await run(async ({prefix: queried, pageToken}) => {
    assert.equal(queried, prefix + "/");
    const rows = [[archive], [record("private")], [record("private"), archive]];
    const objects = rows[reads++];
    assert.equal(pageToken, reads === 2 ? "next" : undefined);
    return {objects, nextPageToken: reads === 1 ? "next" : undefined};
  })(identity);
  assert.equal(result.stable, true);
  assert.equal(result.observedObjects, 2);
  assert.deepEqual(result.blockers, []);
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("replacement, metadata change, addition and missing persistent HOME each block capture evidence", async () => {
  for (const replacement of [[record("file", "101")], [record("file", "100", "2")], [record("file"), record("new")], []]) {
    let first = true;
    const result = await run(async () => {
      const objects = first ? [record("file"), archive] : replacement;
      first = false;
      return {objects};
    })(identity);
    assert.equal(result.stable, false);
    assert.deepEqual(result.blockers, ["legacy_storage_generations_changed", "legacy_persistent_home_archive_missing"]);
  }
});

test("foreign Storage, repeated listing cursors and out-of-prefix metadata fail closed", async () => {
  const foreign = {...identity, sessions: [{homeStoragePrefix: "workspaces/other/workspace", homeStorageBucket: bucket}]};
  assert.deepEqual((await run(() => assert.fail("foreign read"))(foreign)).blockers, ["legacy_storage_session_scope_unverified"]);
  assert.deepEqual((await run(async () => ({objects: [], nextPageToken: "repeat"}))(identity)).blockers,
      ["legacy_storage_listing_cursor_repeated"]);
  assert.deepEqual((await run(async () => ({objects: [{...archive, name: prefix + "-other/object"}]}))(identity)).blockers,
      ["legacy_storage_listing_invalid"]);
});

test("inventory is internal and is only returned for a clear observation", async () => {
  const observe = run(async () => ({objects: [record("z"), archive, record("a")]}));
  const result = await observe(identity, {includeInventory: true});
  assert.deepEqual(result.inventory.map(([name]) => name), [archive.name, record("a").name, record("z").name]);
  assert.ok(!Object.hasOwn(await observe(identity), "inventory"));
  const incomplete = await run(async () => ({objects: [record("a")]}))(identity, {includeInventory: true});
  assert.ok(!Object.hasOwn(incomplete, "inventory"));
  assert.ok(incomplete.blockers.includes("legacy_persistent_home_archive_missing"));
});

test("bounded observation accepts a retained prefix larger than six pages", async () => {
  const total = 3501;
  const result = await run(async ({pageToken}) => {
    const start = pageToken ? Number(pageToken) : 0;
    const objects = Array.from({length: Math.min(500, total - start)}, (_, index) => {
      const ordinal = start + index;
      return ordinal === 0 ? archive : record(`object-${String(ordinal).padStart(5, "0")}`);
    });
    return {objects, nextPageToken: start + objects.length < total ? String(start + objects.length) : undefined};
  })(identity);
  assert.equal(result.stable, true);
  assert.equal(result.observedObjects, total);
  assert.deepEqual(result.blockers, []);
});
