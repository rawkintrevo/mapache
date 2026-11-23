"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {resolveVmEnvironment} = require("./vmEnvironment.service");

function fixture(records = {}) {
  const reads = [];
  const ref = path => ({collection: id => ref(`${path}/${id}`), doc: id => ref(`${path}/${id}`),
    get: async () => { reads.push(path); return {data: () => records[path.split("/").pop()]}; }});
  return {reads, resolve: entryIds => resolveVmEnvironment({db: {collection: ref}, ownerUid: "owner", entryIds})};
}
test("only selected owner paths are read and duplicate IDs are deduplicated", async () => {
  const f = fixture({selected: {ownerUid: "owner", name: "SERVICE_KEY", value: "secret"}});
  assert.deepEqual(await f.resolve(["selected", "selected"]), {SERVICE_KEY: "secret"});
  assert.deepEqual(f.reads, ["users/owner/private/environmentKeys/entries/selected"]);
  assert.deepEqual(await f.resolve([]), {});
});
test("missing, foreign, malformed, duplicate-name and reserved entries fail closed", async () => {
  await assert.rejects(fixture().resolve(["missing"]), /vm_environment_entry_unavailable/);
  await assert.rejects(fixture({a: {ownerUid: "other", name: "KEY", value: "secret"}}).resolve(["a"]), /vm_environment_entry_unavailable/);
  for (const name of ["MAPACHE_VM_CONTROL_URL", "MAPACHE_VM_CONTROL_TOKEN", "MAPACHE_RETAINED_DISK_ROOT", "RUNTIME_PROVIDER", "WORKSPACE_STORAGE_MODE", "RUNTIME_STORAGE_MODE", "GCLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "XDG_CONFIG_HOME", "HOME", "SESSION_ID", "bad-name", "__proto__"]) {
    await assert.rejects(fixture({a: {ownerUid: "owner", name, value: "secret"}}).resolve(["a"]));
  }
  const entry = {ownerUid: "owner", name: "KEY", value: "secret"};
  await assert.rejects(fixture({a: entry, b: entry}).resolve(["a", "b"]), /vm_environment_name_conflict/);
  for (const ids of ["a", ["../foreign"], Array(51).fill("a")]) await assert.rejects(fixture().resolve(ids));
  await assert.rejects(fixture({a: {...entry, value: ""}}).resolve(["a"]), /environment_value_required/);
});
