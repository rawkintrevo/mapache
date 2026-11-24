"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createVmMigrationPreflight} = require("./vmMigrationPreflight.service");

function fixture({workspace = {}, sessions = [], runs = [], destination, fence, uploads, pending = [], version = 1} = {}) {
  const workspacePath = "workspaces/fixture";
  const pathSnapshots = new Map();
  const snapshot = (path, data) => ({
    ref: {path}, exists: data !== undefined,
    updateTime: data === undefined ? undefined : {seconds: 1, nanoseconds: version},
    get: key => data?.[key], data: () => data,
  });
  pathSnapshots.set(workspacePath, snapshot(workspacePath, {ownerUid: "owner", agentRuntimeGeneration: 3, ...workspace}));
  pathSnapshots.set("vmRuntimes_v2/fixture", snapshot("vmRuntimes_v2/fixture", destination));
  pathSnapshots.set("vmMigrationFences_v2/fixture", snapshot("vmMigrationFences_v2/fixture", fence));
  pathSnapshots.set("vmLegacyUploads_v2/fixture", snapshot("vmLegacyUploads_v2/fixture", uploads));
  for (const [path, values] of [[workspacePath + "/sessions", sessions], ["automationRuns", runs], ["vmLegacyUploads_v2/fixture/pending", pending]]) {
    pathSnapshots.set(path, {size: values.length, docs: values.map((row, i) => snapshot(path + "/" + i, row))});
  }
  const ref = path => ({
    path,
    doc: id => ref(path + "/" + id),
    collection: name => ref(path + "/" + name),
    where: () => ref(path),
    limit: () => ref(path),
  });
  const reads = [];
  const db = {collection: ref, runTransaction: async (body, options) => {
    assert.deepEqual(options, {readOnly: true});
    return body({get: async query => { reads.push(query.path); return pathSnapshots.get(query.path); }});
  }};
  return {reads, inspect: (ownerUid = "owner") => createVmMigrationPreflight({db, now: () => 5})({workspaceId: "fixture", ownerUid})};
}

test("reports possibly live and failed legacy writers without exposing record contents", async () => {
  const input = {sessions: [{status: "stop_failed"}, {status: "unknown", secret: "private"}],
    runs: [{status: "queued", ownerUid: "owner"}], destination: {}};
  const result = await fixture(input).inspect();
  assert.deepEqual(result.counts, {observedSessions: 2, possiblyActiveSessions: 1, failedStops: 1, observedQueuedOrActiveRuns: 1});
  for (const blocker of ["destination_registry_exists", "legacy_stop_requires_reconciliation", "legacy_sessions_require_quiesce",
    "background_runs_require_drain", "legacy_admission_fence_unverified"]) assert.ok(result.blockers.includes(blocker));
  assert.equal(result.readyForFreeze, false);
  assert.equal(result.readyForCutover, false);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal((await fixture(input).inspect()).observationSha256, result.observationSha256);
  assert.notEqual((await fixture({...input, version: 2}).inspect()).observationSha256, result.observationSha256);
});

test("wrong owner is rejected before other registry or writer records are read", async () => {
  const check = fixture();
  await assert.rejects(check.inspect("foreign"), {status: 404, publicMessage: "vm_migration_source_not_found"});
  assert.deepEqual(check.reads, ["workspaces/fixture"]);
});

test("inventory truncation and apparently stopped source both fail closed", async () => {
  const input = {sessions: Array.from({length: 501}, () => ({status: "stopped"}))};
  const result = await fixture(input).inspect();
  assert.equal(result.counts.observedSessions, 500);
  assert.ok(result.blockers.includes("legacy_writer_inventory_truncated"));
  const paused = await fixture({sessions: [{status: "stopped"}]}).inspect();
  assert.equal(paused.counts.possiblyActiveSessions, 0);
  assert.deepEqual(paused.blockers, ["legacy_admission_fence_unverified", "live_compute_and_storage_authority_unverified", "untracked_legacy_upload_sessions_unverified"]);
  const fenced = await fixture({fence: {}}).inspect();
  assert.ok(fenced.blockers.includes("migration_fence_already_exists"));
  assert.notEqual(fenced.observationSha256, (await fixture().inspect()).observationSha256);
});

test("preflight reports unresolved minting and the recorded drain window", async () => {
  const pending = await fixture({uploads: {drainUntilMs: 6}, pending: [{}]}).inspect();
  assert.ok(pending.blockers.includes("legacy_upload_issuance_unresolved"));
  assert.ok(pending.blockers.includes("legacy_upload_sessions_require_drain"));
  const elapsed = await fixture({uploads: {drainUntilMs: 4}}).inspect();
  assert.ok(!elapsed.blockers.includes("legacy_upload_sessions_require_drain"));
  assert.ok(elapsed.blockers.includes("untracked_legacy_upload_sessions_unverified"));
});
