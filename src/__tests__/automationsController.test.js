import {afterEach, describe, expect, test, vi} from "vitest";
import {createAutomationsController} from "../controllers/automationsController.js";
import {createInitialState} from "../state/initialState.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {promise, resolve, reject};
}

function createFixture(overrides = {}) {
  const state = {
    ...createInitialState(),
    user: {uid: "user-1"},
    selectedWorkspaceId: "workspace-1",
    workspaces: [{id: "workspace-1", sharedStorageState: "ready"}],
    ...overrides.state,
  };
  const api = {
    listDefinitions: vi.fn().mockResolvedValue({automations: [{id: "automation-1", revision: 3, name: "Daily"}]}),
    createDefinition: vi.fn().mockResolvedValue({automation: {id: "automation-2", revision: 1}}),
    getDefinition: vi.fn().mockResolvedValue({automation: {id: "automation-1", revision: 4, name: "Fresh"}}),
    updateDefinition: vi.fn().mockResolvedValue({automation: {id: "automation-1", revision: 4}}),
    deleteDefinition: vi.fn().mockResolvedValue({ok: true}),
    getSettings: vi.fn().mockResolvedValue({automationMaxConcurrency: 2}),
    updateSettings: vi.fn().mockResolvedValue({automationMaxConcurrency: 3}),
    prepareStorage: vi.fn().mockResolvedValue({operationId: "op-1"}),
    previewSchedule: vi.fn().mockResolvedValue({occurrences: []}),
    runNow: vi.fn().mockResolvedValue({run: {id: "run-1", status: "queued"}}),
    listHistory: vi.fn().mockResolvedValue({runs: [], nextCursor: ""}),
    getRun: vi.fn().mockResolvedValue({run: {id: "run-1", status: "running"}}),
    listEvents: vi.fn().mockResolvedValue({events: [], nextCursor: ""}),
    stopRun: vi.fn().mockResolvedValue({runId: "run-1"}),
    cancelRun: vi.fn().mockResolvedValue({runId: "run-1"}),
    restartRun: vi.fn().mockResolvedValue({run: {id: "run-2", status: "queued"}}),
    ...overrides.api,
  };
  return {
    state,
    api,
    render: vi.fn(),
    intervals: [],
    document: {visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn()},
  };
}

afterEach(() => vi.restoreAllMocks());

describe("automationsController", () => {
  test("loads workspace definitions/settings and tracks revision and storage readiness", async () => {
    const fixture = createFixture();
    const controller = createAutomationsController({
      ...fixture,
      setIntervalImpl: vi.fn(),
    });

    await controller.loadWorkspace();

    expect(fixture.api.listDefinitions).toHaveBeenCalledWith("workspace-1");
    expect(fixture.api.getSettings).toHaveBeenCalledWith("workspace-1");
    expect(fixture.state.automations.definitions).toHaveLength(1);
    expect(fixture.state.automations.editRevision).toBe(3);
    expect(fixture.state.automations.storageReady).toBe(true);
    expect(fixture.state.automations.maxConcurrency).toBe(2);
  });

  test("trusts the prepared shared-storage descriptor when the legacy state field is stale", async () => {
    const fixture = createFixture({
      state: {
        workspaces: [{
          id: "workspace-1",
          sharedStorageState: "legacy",
          sharedStorage: {state: "ready", bucketName: "backend-owned", storageGeneration: "generation-7"},
        }],
      },
    });
    const controller = createAutomationsController({...fixture, setIntervalImpl: vi.fn()});

    await controller.loadWorkspace();

    expect(fixture.state.automations.storageState).toBe("ready");
    expect(fixture.state.automations.storageReady).toBe(true);
  });

  test("loads global history and run details without requiring a selected workspace", async () => {
    const fixture = createFixture({api: {
      listHistory: vi.fn().mockResolvedValue({runs: [{id: "run-global", status: "succeeded"}], nextCursor: "next"}),
      getRun: vi.fn().mockResolvedValue({run: {id: "run-global", status: "succeeded"}}),
      listEvents: vi.fn().mockResolvedValue({events: [{kind: "transcript"}], nextCursor: ""}),
      stopRun: vi.fn().mockResolvedValue({id: "run-global", status: "canceled"}),
      restartRun: vi.fn().mockResolvedValue({run: {id: "run-restarted", status: "queued"}}),
    }});
    fixture.state.selectedWorkspaceId = null;
    const controller = createAutomationsController({...fixture, setIntervalImpl: vi.fn()});

    await controller.loadGlobalHistory();
    expect(fixture.api.listHistory).toHaveBeenCalledWith({});
    expect(fixture.state.automations.globalHistory.runs).toEqual([{id: "run-global", status: "succeeded"}]);
    await controller.selectRun("run-global", {global: true});
    expect(fixture.api.getRun).toHaveBeenCalledWith("run-global");
    expect(fixture.state.automations.selectedRunScope).toBe("global");
    expect(fixture.state.automations.events).toEqual([{kind: "transcript"}]);
    await controller.stopGlobalRun("run-global");
    expect(fixture.api.stopRun).toHaveBeenCalledWith("run-global");
    await controller.restartGlobalRun("run-global");
    expect(fixture.api.restartRun).toHaveBeenCalledWith("run-global", expect.any(String));
  });

  test("ignores a response from a workspace that is no longer selected", async () => {
    const pending = deferred();
    const fixture = createFixture({api: {listDefinitions: vi.fn().mockReturnValue(pending.promise)}});
    const controller = createAutomationsController({...fixture, documentImpl: fixture.document, setIntervalImpl: vi.fn()});
    const request = controller.loadDefinitions();

    fixture.state.selectedWorkspaceId = "workspace-2";
    fixture.state.workspaces = [{id: "workspace-2", sharedStorageState: "legacy"}];
    controller.setWorkspace("workspace-2");
    pending.resolve({automations: [{id: "stale"}]});
    await request;

    expect(fixture.state.automations.selectedWorkspaceId).toBe("workspace-2");
    expect(fixture.state.automations.definitions).toEqual([]);
  });

  test("refreshes a conflicted revision and preserves a visible conflict marker", async () => {
    const conflict = Object.assign(new Error("revision_conflict"), {code: "revision_conflict", status: 409});
    const fixture = createFixture({api: {
      updateDefinition: vi.fn().mockRejectedValue(conflict),
      getDefinition: vi.fn().mockResolvedValue({automation: {id: "automation-1", revision: 4, name: "Other edit"}}),
    }});
    const controller = createAutomationsController({...fixture, documentImpl: fixture.document, setIntervalImpl: vi.fn()});
    await controller.loadDefinitions();
    await controller.updateDefinition("automation-1", {name: "Mine"});

    expect(fixture.api.getDefinition).toHaveBeenCalledWith("workspace-1", "automation-1");
    expect(fixture.state.automations.editRevision).toBe(4);
    expect(fixture.state.automations.conflict).toEqual({type: "revision", automationId: "automation-1"});
  });

  test("reuses a manual run idempotency key on retry and rotates it after success", async () => {
    const fixture = createFixture({api: {
      runNow: vi.fn()
        .mockRejectedValueOnce(new Error("network_failed"))
        .mockResolvedValue({run: {id: "run-1", status: "queued"}}),
    }});
    const controller = createAutomationsController({...fixture, setIntervalImpl: vi.fn()});

    await controller.runNow("automation-1");
    await controller.runNow("automation-1");
    await controller.runNow("automation-1");

    const keys = fixture.api.runNow.mock.calls.map((call) => call[3]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  test("suspends hidden polling and refreshes active history when visible", async () => {
    const fixture = createFixture();
    fixture.document.visibilityState = "hidden";
    let poll;
    const controller = createAutomationsController({
      ...fixture,
      documentImpl: fixture.document,
      setIntervalImpl: (callback) => {
        poll = callback;
        return "poll";
      },
      clearIntervalImpl: vi.fn(),
    });
    await controller.loadWorkspace();
    fixture.state.automations.history.runs = [{id: "run-1", status: "running"}];
    fixture.api.listHistory.mockClear();

    await poll();
    expect(fixture.api.listHistory).not.toHaveBeenCalled();

    fixture.document.visibilityState = "visible";
    await poll();
    expect(fixture.api.listHistory).toHaveBeenCalled();
    controller.dispose();
  });

  test("clears definitions, history, events, and action keys on logout", async () => {
    const fixture = createFixture();
    const controller = createAutomationsController({...fixture, setIntervalImpl: vi.fn()});
    await controller.loadWorkspace();
    fixture.state.automations.selectedRunId = "run-1";
    fixture.state.automations.events = [{kind: "events"}];
    controller.clear();

    expect(fixture.state.automations.definitions).toEqual([]);
    expect(fixture.state.automations.selectedRunId).toBe("");
    expect(fixture.state.automations.events).toEqual([]);
    expect(fixture.state.automations.selectedWorkspaceId).toBeNull();
  });
});
