"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {createExecutionAuthority} = require("./executionAuthority");

function fakeFirestore(initial) {
  const values = new Map(Object.entries(initial));
  const makeRef = (key) => ({
    key,
    collection(name) { return makeRef(`${key}/${name}`); },
    doc(name) { return makeRef(`${key}/${name}`); },
    async get() {
      const value = values.get(key);
      return {exists: value !== undefined, data: () => value && JSON.parse(JSON.stringify(value))};
    },
  });
  return {
    collection(name) { return makeRef(name); },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        get: (ref) => ref.get(),
        set: (ref, value, options = {}) => writes.push({ref, value, options}),
        update: (ref, value) => writes.push({ref, value, options: {merge: true}}),
      };
      const result = await callback(transaction);
      for (const write of writes) {
        const current = values.get(write.ref.key) || {};
        values.set(write.ref.key, write.options.merge ? {...current, ...write.value} : write.value);
      }
      return result;
    },
    value(key) { return values.get(key); },
  };
}

function admin() {
  return {firestore: {FieldValue: {serverTimestamp: () => "server-time"}}};
}

function authorityFixture(overrides = {}) {
  const workspace = {
    syncWriterSessionId: "session-1",
    syncWriterLeaseId: "writer-1",
    ...(overrides.workspace || {}),
  };
  const session = {
    syncWriterRole: "writer",
    syncWriterLeaseId: "writer-1",
    ...(overrides.session || {}),
  };
  const db = fakeFirestore({
    "workspaces/workspace-1": workspace,
    "workspaces/workspace-1/sessions/session-1": session,
  });
  let wall = 1000;
  let monotonic = 5000;
  const lost = [];
  const authority = createExecutionAuthority({
    admin: admin(),
    config: {webFirstEnabled: true, workspaceId: "workspace-1", sessionId: "session-1"},
    db,
    runtimeId: "runtime-1",
    leaseMs: 100,
    renewIntervalMs: 50,
    clock: {now: () => wall, monotonic: () => monotonic},
    onLost: async (info) => lost.push(info),
    timers: {setTimeout: () => null, clearTimeout: () => {}},
  });
  return {authority, db, lost, setWall: (value) => { wall = value; }, setMonotonic: (value) => { monotonic = value; }};
}

test("acquires and renews only while the existing workspace writer reservation matches", async () => {
  const fixture = authorityFixture();
  const first = await fixture.authority.acquire();
  assert.equal(first.executionEpoch, 1);
  assert.equal(fixture.authority.canMutate(), true);
  fixture.setWall(1050);
  fixture.setMonotonic(5050);
  await fixture.authority.renew();
  assert.equal(fixture.authority.snapshot().executionEpoch, 1);

  fixture.db.value("workspaces/workspace-1").syncWriterLeaseId = "other-writer";
  await assert.rejects(fixture.authority.renew(), {code: "execution_writer_reservation_required"});
  assert.equal(fixture.authority.snapshot().state, "fenced");
  assert.equal(fixture.authority.canMutate(), false);
  assert.equal(fixture.lost[0].reason, "renewal_unconfirmed");
});

test("does not acquire over an uncertain predecessor and uses a new monotonic epoch after release", async () => {
  const first = authorityFixture();
  await first.authority.acquire();
  await first.authority.release("test_shutdown");
  assert.equal(first.authority.snapshot().state, "released");

  const second = authorityFixture({workspace: {
    executionAuthority: {state: "active", runtimeId: "old-runtime", executionEpoch: 7, sessionId: "session-1"},
  }});
  await assert.rejects(second.authority.acquire(), {code: "execution_recovery_required"});
  assert.equal(second.authority.snapshot().executionEpoch, null);
});

test("expires from the last confirmed monotonic deadline without extending on an unanswered renewal", async () => {
  const fixture = authorityFixture();
  await fixture.authority.acquire();
  fixture.setMonotonic(5100);
  assert.throws(() => fixture.authority.assertAuthority(), {code: "execution_authority_lost"});
  assert.equal(fixture.authority.snapshot().state, "fenced");
});
