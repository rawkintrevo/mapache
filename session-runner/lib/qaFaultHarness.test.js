"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createQaFaultHarness, QA_FAULT_HARNESS_ID} = require("./qaFaultHarness");

function createStore() {
  const session = {
    agentUiVersion: "pi-web-ui-v1",
    sessionEnv: {MAPACHE_QA_FAULT_HARNESS: QA_FAULT_HARNESS_ID},
  };
  const sessionRef = {
    id: "session-1",
    get: async () => ({exists: true, data: () => session}),
  };
  const sessionsRef = {doc: () => sessionRef};
  const workspaceRef = {collection: () => sessionsRef};
  const db = {
    collection: () => ({doc: () => workspaceRef}),
    async runTransaction(callback) {
      return callback({
        get: async () => ({exists: true, data: () => session}),
        update: (_ref, updates) => Object.assign(session, updates),
      });
    },
  };
  return {db, session};
}

function config() {
  return {
    agentRuntimeEnabled: true,
    agentRuntimeGeneration: "1",
    agentUiVersion: "pi-web-ui-v1",
    qaCase: "pi-web-failure-recovery",
    qaFaultHarness: QA_FAULT_HARNESS_ID,
    sessionId: "session-1",
    workspaceId: "workspace-1",
  };
}

test("QA fault harness arms and consumes one-shot faults transactionally", async () => {
  const store = createStore();
  const harness = createQaFaultHarness({config: config(), db: store.db, now: () => "2026-09-12T00:00:00.000Z"});

  assert.equal((await harness.status()).enabled, true);
  await harness.arm("storage-publication");
  assert.equal(await harness.consume("storage-publication"), true);
  assert.equal(await harness.consume("storage-publication"), false);
  assert.deepEqual((await harness.status()).consumed, ["storage-publication"]);
});

test("QA fault harness exposes a bounded short-lived access fixture", async () => {
  const store = createStore();
  const harness = createQaFaultHarness({config: config(), db: store.db});

  await harness.arm("short-lived-access", {ttlMs: 500});
  const status = await harness.status();
  assert.equal(status.armed["short-lived-access"].ttlMs, 1_000);
  assert.equal(status.accessRenewalTtlMs, 1_000);
});

test("QA writer revocation calls the authority boundary", async () => {
  const store = createStore();
  let revoked = "";
  const harness = createQaFaultHarness({
    config: config(),
    db: store.db,
    workspaceAuthority: {
      revokeForQa: async (reason) => { revoked = reason; },
    },
  });

  await harness.arm("writer-revocation");
  assert.deepEqual(await harness.revokeWriter(), {ok: true, fault: "writer-revocation", state: "revoked"});
  assert.equal(revoked, "qa_writer_revoked");
});

test("QA forced loss releases authority and schedules process loss", async () => {
  const store = createStore();
  const events = [];
  const harness = createQaFaultHarness({
    config: config(),
    db: store.db,
    processImpl: {pid: 123, kill: (pid, signal) => events.push({pid, signal})},
    setTimeoutImpl: (callback) => {
      callback();
      return {unref() {}};
    },
    workspaceAuthority: {
      release: async (reason) => events.push(reason),
    },
  });

  await harness.arm("no-auto-resume");
  assert.deepEqual(await harness.forceLoss(), {ok: true, fault: "no-auto-resume", state: "forced-loss-scheduled"});
  assert.deepEqual(events, ["qa_forced_loss", {pid: 123, signal: "SIGKILL"}]);
});
