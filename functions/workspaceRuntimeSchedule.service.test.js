"use strict";

const assert = require("node:assert/strict");
const {createWorkspaceRuntimeScheduleService} = require("./workspaceRuntimeSchedule.service");

const DELETE = Symbol("delete");
const FIXED_NOW = new Date("2026-10-19T18:00:00.000Z");
const SCHEDULE = {days: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "18:00", timezone: "America/Chicago"};

function makeHarness({workspace: initialWorkspace, sessions: initialSessions = [], now = FIXED_NOW, onStart, onRestart, onStop} = {}) {
  const workspace = {...initialWorkspace};
  const sessions = new Map(initialSessions.map((session) => [session.id, {...session}]));
  const workspaceRef = makeRef("workspace-1", () => workspace, (updates) => applyUpdates(workspace, updates));
  const cursor = {};
  const cursorRef = {
    get: async () => ({exists: true, data: () => ({...cursor})}),
    set: async (updates) => Object.assign(cursor, updates),
  };
  const workspaceCollection = {
    doc: () => workspaceRef,
    where: (field, operator, value) => {
      assert.equal(field, "runtimePolicy.mode");
      assert.equal(operator, "==");
      assert.equal(value, "scheduled");
      return {
        limit: () => ({get: async () => ({
          docs: workspace.runtimePolicy?.mode === value ? [{
            id: workspaceRef.id,
            ref: {path: `workspaces/${workspaceRef.id}`, parent: {id: "workspaces", parent: null}},
          }] : [],
        })}),
      };
    },
  };
  const sessionCollection = () => ({
    doc: (sessionId) => makeRef(sessionId, () => sessions.get(sessionId), (updates) => {
      const session = sessions.get(sessionId);
      applyUpdates(session, updates);
    }),
    get: async () => ({
      docs: [...sessions.entries()].map(([id, value]) => ({id, data: () => ({...value})})),
    }),
  });
  const db = {
    collection: (name) => {
      if (name === "appConfig") return {doc: (id) => {
        assert.equal(id, "runtimeScheduleCursor");
        return cursorRef;
      }};
      assert.equal(name, "workspaces");
      return workspaceCollection;
    },
    runTransaction: async (callback) => callback({
      get: async (ref) => ref.get(),
      update: (ref, updates) => ref.update(updates),
    }),
  };
  const admin = {firestore: {FieldValue: {
    delete: () => DELETE,
    serverTimestamp: () => now,
  }}};
  const started = [];
  const restarted = [];
  const stopped = [];
  const service = createWorkspaceRuntimeScheduleService({
    admin,
    db,
    now: () => now,
    sessionCollection,
    requireSession: async () => {},
    createSession: async (uid, workspaceId, payload) => {
      started.push({uid, workspaceId, payload});
      if (onStart) await onStart({sessions, workspace, uid, workspaceId, payload});
      return {id: "new-session", status: "provisioning"};
    },
    restartSession: async (...args) => {
      restarted.push(args);
      if (onRestart) await onRestart({sessions, workspace, args});
    },
    restartSessionForSchedule: async (uid, workspaceId, sessionId) => {
      restarted.push([uid, workspaceId, sessionId]);
      if (onRestart) await onRestart({sessions, workspace, args: [uid, workspaceId, sessionId]});
    },
    stopSession: async (...args) => {
      stopped.push(args);
      if (onStop) await onStop({sessions, workspace, args});
    },
    stopSessionForSchedule: async (uid, workspaceId, sessionId) => {
      stopped.push([uid, workspaceId, sessionId]);
      if (onStop) await onStop({sessions, workspace, args: [uid, workspaceId, sessionId]});
    },
  });
  return {service, workspace, sessions, started, restarted, stopped, cursor};
}

function makeRef(id, read, write) {
  return {
    id,
    get: async () => {
      const value = read();
      return {exists: Boolean(value), id, data: () => value ? {...value} : undefined};
    },
    update: async (updates) => write(updates),
  };
}

function applyUpdates(target, updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (value === DELETE) delete target[key];
    else target[key] = value;
  }
}

function workspace(overrides = {}) {
  return {
    ownerUid: "user-1",
    canonicalSessionId: "session-1",
    runtimePolicy: {mode: "scheduled", schedule: SCHEDULE},
    runtimePolicyRevision: 1,
    ...overrides,
  };
}

(async () => {
  // Exercise discovery through runTick, without injecting listScheduledWorkspaces.
  // Root workspaces use automatic collection indexes; a collection-group query
  // requires a separate index and previously failed before any reconciliation.
  for (const [mode, now, initialStatus, expectedAction] of [
    ["scheduled", FIXED_NOW, "stopped", "opened"],
    ["scheduled", new Date("2026-10-19T23:00:00.000Z"), "running", "closed"],
    ["idle", FIXED_NOW, "stopped", null],
  ]) {
    const harness = makeHarness({
      workspace: workspace({runtimePolicy: {mode, schedule: SCHEDULE}}),
      sessions: [{id: "session-1", status: initialStatus, ownerUid: "user-1"}],
      now,
    });
    const result = await harness.service.runTick();
    assert.equal(result.checked, expectedAction ? 1 : 0);
    assert.equal(result.failed, 0);
    assert.equal(result.opened, expectedAction === "opened" ? 1 : 0);
    assert.equal(result.closed, expectedAction === "closed" ? 1 : 0);
    assert.equal(harness.restarted.length, result.opened);
    assert.equal(harness.stopped.length, result.closed);
    assert.equal(harness.cursor.lastWorkspacePath, "", "a completed scan resets the cursor");
  }

  {
    const harness = makeHarness({
      workspace: workspace(),
      sessions: [{id: "session-1", status: "stopped", ownerUid: "user-1"}],
      onRestart: ({sessions}) => { sessions.get("session-1").status = "provisioning"; },
    });
    const result = await harness.service.reconcileWorkspace("workspace-1", FIXED_NOW);
    assert.equal(result.action, "start_requested");
    assert.deepEqual(harness.restarted[0], ["user-1", "workspace-1", "session-1"]);
    assert.equal(harness.workspace.runtimeScheduleStatus, "open");
    assert.equal(harness.workspace.runtimeScheduleNextEvent.action, "stop");
    await harness.service.reconcileWorkspace("workspace-1", FIXED_NOW);
    assert.equal(harness.restarted.length, 1, "a provisioning lifecycle transition is not started twice");
  }

  {
    const harness = makeHarness({
      workspace: workspace({runtimeScheduleManualPauseWindowKey: "2026-10-19"}),
      sessions: [{id: "session-1", status: "stopped", ownerUid: "user-1"}],
    });
    const result = await harness.service.reconcileWorkspace("workspace-1", FIXED_NOW);
    assert.equal(result.action, "manually_paused");
    assert.equal(harness.restarted.length, 0);
    assert.equal(harness.workspace.runtimeScheduleStatus, "manually_paused");
    assert.equal(harness.workspace.runtimeScheduleNextEvent.action, "start");
  }

  {
    const close = new Date("2026-10-19T23:00:00.000Z");
    const harness = makeHarness({
      workspace: workspace(),
      sessions: [{id: "session-1", status: "running", serviceUrl: "https://runner", ownerUid: "user-1"}],
      now: close,
      onStop: ({sessions}) => { sessions.get("session-1").status = "stopped"; },
    });
    const result = await harness.service.reconcileWorkspace("workspace-1", close);
    assert.equal(result.action, "stopped");
    assert.deepEqual(harness.stopped[0], ["user-1", "workspace-1", "session-1"]);
    assert.equal(harness.workspace.runtimeScheduleStatus, "closed");
  }

  {
    let attempt = 0;
    const harness = makeHarness({
      workspace: workspace(),
      sessions: [{id: "session-1", status: "stopped", ownerUid: "user-1"}],
      onRestart: ({sessions}) => {
        attempt++;
        if (attempt === 1) {
          const error = new Error("automation_requires_main_paused");
          error.code = "automation_requires_main_paused";
          throw error;
        }
        sessions.get("session-1").status = "provisioning";
      },
    });
    const failed = await harness.service.reconcileWorkspace("workspace-1", FIXED_NOW);
    assert.equal(failed.failed, true);
    assert.equal(harness.workspace.runtimeScheduleError.code, "automation_requires_main_paused");
    assert.equal(harness.workspace.runtimeScheduleError.action, "start");
    const recovered = await harness.service.reconcileWorkspace("workspace-1", FIXED_NOW);
    assert.equal(recovered.action, "start_requested");
    assert.equal(harness.workspace.runtimeScheduleError, null);
    assert.equal(attempt, 2, "a later tick retries startup while the window is open");
  }

  {
    const harness = makeHarness({workspace: workspace({deleted: true})});
    const result = await harness.service.reconcileWorkspace("workspace-1", FIXED_NOW);
    assert.equal(result.skipped, true);
    assert.equal(harness.started.length + harness.restarted.length + harness.stopped.length, 0);
  }

  {
    const harness = makeHarness({workspace: workspace({runtimePolicy: {mode: "idle", schedule: SCHEDULE}})});
    const result = await harness.service.reconcileWorkspace("workspace-1", FIXED_NOW);
    assert.equal(result.skipped, true);
    assert.equal(harness.started.length, 0);
  }

  {
    const harness = makeHarness({
      workspace: workspace({runtimePolicy: {mode: "idle", schedule: null}, canonicalSessionId: null}),
    });
    const result = await harness.service.updatePolicy("user-1", "workspace-1", {
      mode: "scheduled",
      schedule: SCHEDULE,
    });
    assert.equal(result.runtimePolicy.mode, "scheduled");
    assert.equal(harness.workspace.runtimeScheduleStatus, "open", "enabling inside the window reconciles immediately");
    assert.equal(harness.started.length, 1);
    assert.match(harness.started[0].payload.operationId, /^runtime-schedule-/);
  }

  {
    const running = {id: "session-1", status: "running", ownerUid: "user-1", longRunning: false};
    const harness = makeHarness({
      workspace: workspace(),
      sessions: [running],
    });
    await harness.service.updatePolicy("user-1", "workspace-1", {mode: "idle", schedule: SCHEDULE});
    assert.equal(harness.workspace.runtimePolicy.mode, "idle");
    assert.equal(harness.sessions.get("session-1").status, "running", "disabling scheduling does not stop the runtime");
    assert.equal(harness.stopped.length, 0);
  }

  console.log("workspace runtime schedule service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
