"use strict";

const assert = require("assert");
const {
  QA_FAULT_HARNESS_ID,
  consumeQaFault,
  isQaFaultHarnessSession,
  qaFaultAccessTtlMs,
} = require("./qaFaultHarness.helpers");

function createStore(session) {
  const state = {session};
  const sessionRef = {};
  return {
    state,
    sessionRef,
    db: {
      async runTransaction(callback) {
        await callback({
          get: async () => ({exists: true, data: () => state.session}),
          update: (_ref, updates) => Object.assign(state.session, updates),
        });
      },
    },
  };
}

const workspace = {agentUiVersion: "pi-web-ui-v1"};
const session = {
  agentUiVersion: "pi-web-ui-v1",
  sessionEnv: {
    QA_CASE: "pi-web-failure-recovery",
    MAPACHE_QA_FAULT_HARNESS: QA_FAULT_HARNESS_ID,
  },
  qaFaultHarness: {
    id: QA_FAULT_HARNESS_ID,
    accessRenewalTtlMs: 1000,
    armed: {"uncertain-replacement": {remaining: 1}},
  },
};

assert.strictEqual(isQaFaultHarnessSession(workspace, session), true);
assert.strictEqual(isQaFaultHarnessSession({}, session), false);
assert.strictEqual(isQaFaultHarnessSession(workspace, {
  ...session,
  sessionEnv: {MAPACHE_QA_FAULT_HARNESS: "other"},
}), false);
assert.strictEqual(qaFaultAccessTtlMs({qaFaultHarness: {id: QA_FAULT_HARNESS_ID, accessRenewalTtlMs: 500}}, 60000), 1000);
assert.strictEqual(qaFaultAccessTtlMs({qaFaultHarness: {id: QA_FAULT_HARNESS_ID, accessRenewalTtlMs: 999999}}, 60000), 60000);
assert.strictEqual(qaFaultAccessTtlMs({}, 60000), 60000);

(async () => {
  const store = createStore(structuredClone(session));
  assert.strictEqual(await consumeQaFault(store.sessionRef, store.state.session, "uncertain-replacement", {
    db: store.db,
    workspace,
  }), true);
  assert.strictEqual(await consumeQaFault(store.sessionRef, store.state.session, "uncertain-replacement", {
    db: store.db,
    workspace,
  }), false);
  assert.deepStrictEqual(store.state.session.qaFaultHarness.armed, {});

  const unmarked = createStore({
    ...session,
    sessionEnv: {},
  });
  assert.strictEqual(await consumeQaFault(unmarked.sessionRef, unmarked.state.session, "uncertain-replacement", {
    db: unmarked.db,
    workspace,
  }), false);
  console.log("QA fault harness helper tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
