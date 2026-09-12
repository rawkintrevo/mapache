"use strict";

const assert = require("assert");
const {QA_FAULT_HARNESS_ID, createQaFaultHarnessService} = require("./qaFaultHarness.service");

function createDependencies(session, workspace = {agentUiVersion: "pi-web-ui-v1"}) {
  const calls = [];
  return {
    calls,
    requireSession: async () => ({sessionSnap: {data: () => session}, workspace}),
    requestRunnerJson: async (runnerSession, route, options = {}) => {
      calls.push({runnerSession, route, options});
      return {ok: true};
    },
  };
}

(async () => {
  const session = {
    agentUiVersion: "pi-web-ui-v1",
    sessionEnv: {
      QA_CASE: "pi-web-failure-recovery",
      MAPACHE_QA_FAULT_HARNESS: QA_FAULT_HARNESS_ID,
    },
  };
  const dependencies = createDependencies(session);
  const service = createQaFaultHarnessService(dependencies);

  assert.deepStrictEqual(await service.getStatus("uid-1", "workspace-1", "session-1"), {ok: true});
  assert.deepStrictEqual(await service.arm("uid-1", "workspace-1", "session-1", {
    action: "arm",
    fault: "short-lived-access",
    ttlMs: 500,
  }), {ok: true});
  assert.strictEqual(dependencies.calls[0].route, "/qa/faults/status");
  assert.deepStrictEqual(dependencies.calls[1].options.body, {
    action: "arm",
    fault: "short-lived-access",
    ttlMs: 1000,
  });

  await assert.rejects(
      () => service.arm("uid-1", "workspace-1", "session-1", {action: "arm", fault: "not-a-fault"}),
      (error) => error.status === 400 && error.message === "qa_fault_unknown",
  );
  const unmarked = createQaFaultHarnessService(createDependencies(session, {}));
  await assert.rejects(
      () => unmarked.getStatus("uid-1", "workspace-1", "session-1"),
      (error) => error.status === 404 && error.message === "qa_fault_harness_unavailable",
  );
  console.log("QA fault harness service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
