"use strict";

const assert = require("node:assert/strict");
const {AGENT_UI_VERSION} = require("./agentRuntime.helpers");
const {createWorkspaceSessionReservationService} = require("./workspaceSessionReservation.service");

const DELETE_FIELD = Symbol("delete-field");
const admin = {
  firestore: {
    FieldValue: {
      delete: () => DELETE_FIELD,
      serverTimestamp: () => "SERVER_TIMESTAMP",
    },
  },
};

function clone(value) {
  if (value === DELETE_FIELD || value == null) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function createFakeFirestore(initialWorkspace, initialSessions = {}) {
  const state = {
    version: 0,
    workspace: clone(initialWorkspace),
    sessions: new Map(Object.entries(initialSessions).map(([id, session]) => [id, clone(session)])),
  };
  const workspaceRef = {
    id: "workspace-1",
    collection(name) {
      assert.strictEqual(name, "sessions");
      return sessionsRef;
    },
  };
  const sessionsRef = {
    id: "sessions",
    doc(id) {
      return {id, parent: sessionsRef};
    },
  };

  function snapshot(ref) {
    if (ref === workspaceRef) {
      return {exists: true, data: () => clone(state.workspace)};
    }
    if (ref === sessionsRef) {
      return {
        docs: [...state.sessions.entries()].map(([id, session]) => ({
          id,
          ref: {id, parent: sessionsRef},
          exists: true,
          data: () => clone(session),
        })),
      };
    }
    const session = state.sessions.get(ref.id);
    return {exists: Boolean(session), data: () => clone(session || {})};
  }

  const firestore = {
    collection(name) {
      assert.strictEqual(name, "workspaces");
      return {doc: (id) => {
        assert.strictEqual(id, "workspace-1");
        return workspaceRef;
      }};
    },
    async runTransaction(callback) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const readVersion = state.version;
        const writes = [];
        const transaction = {
          get: async (ref) => {
            await new Promise((resolve) => setImmediate(resolve));
            return snapshot(ref);
          },
          set: (ref, value) => writes.push({kind: "set", ref, value: clone(value)}),
          update: (ref, value) => writes.push({kind: "update", ref, value: clone(value)}),
        };
        const result = await callback(transaction);
        if (readVersion !== state.version) continue;
        writes.forEach(({kind, ref, value}) => {
          if (ref === workspaceRef) {
            applyUpdates(state.workspace, kind === "set" ? value : value);
          } else {
            const current = state.sessions.get(ref.id) || {};
            if (kind === "set") state.sessions.set(ref.id, value);
            else applyUpdates(current, value);
          }
        });
        state.version++;
        return result;
      }
      throw new Error("fake_transaction_retry_limit");
    },
    state,
  };
  return {firestore, workspaceRef, sessionsRef, state};
}

function applyUpdates(target, updates) {
  Object.entries(updates || {}).forEach(([key, value]) => {
    if (value === DELETE_FIELD) delete target[key];
    else target[key] = value;
  });
}

function session(id, operationId, status = "provisioning") {
  return {
    id,
    ownerUid: "user-1",
    workspaceId: "workspace-1",
    agentUiVersion: AGENT_UI_VERSION,
    provisioningOperationId: operationId,
    capabilities: {chrome: true},
    sessionType: "cloud",
    status,
  };
}

function sessionRef(sessionsRef, id) {
  return sessionsRef.doc(id);
}

(async () => {
  const equal = createFakeFirestore({agentUiVersion: AGENT_UI_VERSION});
  const equalService = createWorkspaceSessionReservationService({db: equal.firestore, admin});
  const equalA = session("session-equal", "operation-equal");
  const equalB = {...equalA, name: "second caller"};
  await Promise.all([
    equalService.reserveChromeWorkspaceSession("workspace-1", sessionRef(equal.sessionsRef, equalA.id), equalA, {
      newRuntime: true,
      runtimeOperationId: equalA.provisioningOperationId,
      syncWriterEligible: true,
    }),
    equalService.reserveChromeWorkspaceSession("workspace-1", sessionRef(equal.sessionsRef, equalB.id), equalB, {
      newRuntime: true,
      runtimeOperationId: equalB.provisioningOperationId,
      syncWriterEligible: true,
    }),
  ]);
  assert.strictEqual(equal.state.sessions.size, 1);
  assert.strictEqual(equal.state.workspace.agentRuntimeGeneration, 1);
  assert.strictEqual(equal.state.workspace.agentRuntimeSessionId, "session-equal");

  const different = createFakeFirestore({agentUiVersion: AGENT_UI_VERSION});
  const differentService = createWorkspaceSessionReservationService({db: different.firestore, admin});
  const outcomes = await Promise.allSettled([
    differentService.reserveChromeWorkspaceSession("workspace-1", sessionRef(different.sessionsRef, "session-a"), session("session-a", "operation-a"), {
      newRuntime: true,
      runtimeOperationId: "operation-a",
      syncWriterEligible: true,
    }),
    differentService.reserveChromeWorkspaceSession("workspace-1", sessionRef(different.sessionsRef, "session-b"), session("session-b", "operation-b"), {
      newRuntime: true,
      runtimeOperationId: "operation-b",
      syncWriterEligible: true,
    }),
  ]);
  assert.strictEqual(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.strictEqual(outcomes.filter((outcome) => outcome.status === "rejected")[0].reason.publicMessage,
      "agent_runtime_workspace_busy");
  assert.strictEqual(different.state.sessions.size, 1);

  const failed = createFakeFirestore({agentUiVersion: AGENT_UI_VERSION});
  const failedService = createWorkspaceSessionReservationService({db: failed.firestore, admin});
  const failedSession = session("session-failed", "operation-failed");
  await failedService.reserveChromeWorkspaceSession("workspace-1", sessionRef(failed.sessionsRef, failedSession.id), failedSession, {
    newRuntime: true,
    runtimeOperationId: failedSession.provisioningOperationId,
    syncWriterEligible: true,
  });
  const admittedFailedSession = {...failed.state.sessions.get(failedSession.id), id: failedSession.id};
  failed.state.sessions.get(failedSession.id).status = "provision_failed";
  await failedService.releaseChromeWorkspaceSession(
      sessionRef(failed.sessionsRef, failedSession.id),
      admittedFailedSession,
      "provision_failed",
  );
  const replacement = session("session-replacement", "operation-replacement");
  await failedService.reserveChromeWorkspaceSession("workspace-1", sessionRef(failed.sessionsRef, replacement.id), replacement, {
    newRuntime: true,
    runtimeOperationId: replacement.provisioningOperationId,
    syncWriterEligible: true,
  });
  assert.strictEqual(failed.state.workspace.agentRuntimeGeneration, 2);
  assert.strictEqual(failed.state.workspace.agentRuntimeSessionId, replacement.id);
  await failedService.reserveChromeWorkspaceSession("workspace-1", sessionRef(failed.sessionsRef, failedSession.id), admittedFailedSession, {
    newRuntime: true,
    runtimeOperationId: failedSession.provisioningOperationId,
    syncWriterEligible: true,
  });
  assert.strictEqual(failed.state.workspace.agentRuntimeSessionId, replacement.id);

  const stopping = createFakeFirestore({agentUiVersion: AGENT_UI_VERSION}, {
    "session-stopping": session("session-stopping", "operation-stopping", "stopping"),
  });
  const stoppingService = createWorkspaceSessionReservationService({db: stopping.firestore, admin});
  stopping.state.workspace = {
    agentUiVersion: AGENT_UI_VERSION,
    agentRuntimeSessionId: "session-stopping",
    agentRuntimeOperationId: "operation-stopping",
    agentRuntimeGeneration: 1,
    agentRuntimeState: "stopping",
  };
  await assert.rejects(
      stoppingService.reserveChromeWorkspaceSession("workspace-1", sessionRef(stopping.sessionsRef, "session-next"), session("session-next", "operation-next"), {
        newRuntime: true,
        runtimeOperationId: "operation-next",
        syncWriterEligible: true,
      }),
      (error) => error.status === 409 && error.publicMessage === "agent_runtime_workspace_busy",
  );

  const legacy = createFakeFirestore({});
  const legacyService = createWorkspaceSessionReservationService({db: legacy.firestore, admin});
  await legacyService.reserveChromeWorkspaceSession("workspace-1", sessionRef(legacy.sessionsRef, "legacy"), {
    ...session("legacy", "legacy-operation"),
    agentUiVersion: undefined,
  }, {syncWriterEligible: true});
  assert.strictEqual(legacy.state.workspace.agentRuntimeGeneration, undefined);
  assert.strictEqual(legacy.state.sessions.get("legacy").agentRuntimeGeneration, undefined);

  const automation = createFakeFirestore({agentUiVersion: AGENT_UI_VERSION});
  const automationService = createWorkspaceSessionReservationService({db: automation.firestore, admin});
  await Promise.all([
    automationService.reserveChromeWorkspaceSession(
        "workspace-1", sessionRef(automation.sessionsRef, "auto-run-a"),
        {...session("auto-run-a", "run-a"), runtimeKind: "automation", automationRunId: "run-a"},
        {newRuntime: true, runtimeOperationId: "run-a", singleRunner: false, syncWriterEligible: true},
    ),
    automationService.reserveChromeWorkspaceSession(
        "workspace-1", sessionRef(automation.sessionsRef, "auto-run-b"),
        {...session("auto-run-b", "run-b"), runtimeKind: "automation", automationRunId: "run-b"},
        {newRuntime: true, runtimeOperationId: "run-b", singleRunner: false, syncWriterEligible: true},
    ),
  ]);
  assert.equal(automation.state.sessions.size, 2);
  assert.equal(automation.state.workspace.agentRuntimeSessionId, undefined);
  assert.equal(automation.state.sessions.get("auto-run-a").syncWriterRole, "none");
  assert.equal(automation.state.sessions.get("auto-run-b").syncWriterRole, "none");

  const parallelMain = session("session-main", "operation-main");
  await automationService.reserveChromeWorkspaceSession(
      "workspace-1", sessionRef(automation.sessionsRef, parallelMain.id), parallelMain,
      {newRuntime: true, runtimeOperationId: "operation-main", syncWriterEligible: true},
  );
  assert.equal(automation.state.sessions.size, 3);
  assert.equal(automation.state.workspace.agentRuntimeSessionId, "session-main");

  const exclusive = createFakeFirestore({
    agentUiVersion: AGENT_UI_VERSION,
    automationMainExclusionRunId: "run-exclusive",
  }, {
    "auto-run-exclusive": {
      ...session("auto-run-exclusive", "run-exclusive", "running"),
      runtimeKind: "automation",
      automationRunId: "run-exclusive",
    },
  });
  const exclusiveService = createWorkspaceSessionReservationService({db: exclusive.firestore, admin});
  await assert.rejects(
      exclusiveService.reserveChromeWorkspaceSession(
          "workspace-1", sessionRef(exclusive.sessionsRef, "session-main"),
          session("session-main", "operation-main"),
          {newRuntime: true, runtimeOperationId: "operation-main", syncWriterEligible: true},
      ),
      (error) => error.status === 409 && error.publicMessage === "automation_requires_main_paused",
  );

  console.log("workspace session reservation service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
