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
