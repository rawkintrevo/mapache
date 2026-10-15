import {describe, expect, test, vi} from "vitest";
import {editSessionState, retryProvisioningSessionState, setSessionLongRunningState, setWorkspaceRuntimePolicyState} from "./sessionLifecycle.js";

describe("session edit workflow", () => {
  test("renames and resizes only the fields that changed", async () => {
    const dispatch = vi.fn();
    const state = {
      selectedWorkspaceId: "workspace-1",
      sessions: [{id: "session-1", name: "Old name", resources: {cpu: "1", memory: "2Gi"}}],
      api: {
        getSessions: vi.fn().mockResolvedValue({
          sessions: [{id: "session-1", name: "New name", resources: {cpu: "2", memory: "4Gi"}}],
        }),
        renameSession: vi.fn().mockResolvedValue({}),
        resizeSession: vi.fn().mockResolvedValue({}),
      },
    };

    await editSessionState(state, "session-1", {
      name: "New name",
      resources: {cpu: "2", memory: "4Gi"},
    }, dispatch);

    expect(state.api.renameSession).toHaveBeenCalledWith("workspace-1", "session-1", "New name");
    expect(state.api.resizeSession).toHaveBeenCalledWith("workspace-1", "session-1", {cpu: "2", memory: "4Gi"});
    expect(state.sessions[0].name).toBe("New name");
  });

  test("does not mutate the API when no values changed", async () => {
    const state = {
      selectedWorkspaceId: "workspace-1",
      sessions: [{id: "session-1", name: "Same", resources: {cpu: "1", memory: "2Gi"}}],
      api: {
        getSessions: vi.fn().mockResolvedValue({
          sessions: [{id: "session-1", name: "Same", resources: {cpu: "1", memory: "2Gi"}}],
        }),
        renameSession: vi.fn(),
        resizeSession: vi.fn(),
      },
    };

    await editSessionState(state, "session-1", {
      name: "Same",
      resources: {cpu: "1", memory: "2Gi"},
    }, vi.fn());

    expect(state.api.renameSession).not.toHaveBeenCalled();
    expect(state.api.resizeSession).not.toHaveBeenCalled();
  });
});

describe("session idle policy workflow", () => {
  test("persists the Long-running selection and refreshes the session", async () => {
    const dispatch = vi.fn();
    const state = {
      selectedWorkspaceId: "workspace-1",
      sessions: [{id: "session-1", longRunning: false}],
      api: {
        getSessions: vi.fn().mockResolvedValue({sessions: [{id: "session-1", longRunning: true}]}),
        setSessionLongRunning: vi.fn().mockResolvedValue({}),
      },
    };

    await setSessionLongRunningState(state, "session-1", true, dispatch);

    expect(state.api.setSessionLongRunning).toHaveBeenCalledWith("workspace-1", "session-1", true);
    expect(state.sessions[0].longRunning).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({type: expect.any(String), sessionId: "session-1"});
  });

  test("saves the workspace runtime policy and refreshes workspace and session state", async () => {
    const dispatch = vi.fn();
    const state = {
      selectedWorkspaceId: "workspace-1",
      selectedSessionId: "session-1",
      workspaces: [{id: "workspace-1", name: "Demo"}],
      sessions: [],
      api: {
        updateWorkspaceRuntimePolicy: vi.fn().mockResolvedValue({workspace: {
          id: "workspace-1",
          runtimePolicy: {mode: "scheduled", schedule: {days: [1], startTime: "09:00", endTime: "17:00", timezone: "UTC"}},
        }}),
        getSessions: vi.fn().mockResolvedValue({sessions: [{id: "session-1", longRunning: false}]}),
      },
    };
    const policy = {mode: "scheduled", schedule: {days: [1], startTime: "09:00", endTime: "17:00", timezone: "UTC"}};

    await setWorkspaceRuntimePolicyState(state, policy, dispatch);

    expect(state.api.updateWorkspaceRuntimePolicy).toHaveBeenCalledWith("workspace-1", policy);
    expect(state.workspaces[0].runtimePolicy).toEqual(policy);
    expect(state.sessions[0].longRunning).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({type: expect.any(String), sessionId: "session-1"});
  });
});

describe("session retry workflow", () => {
  test("calls restart once without applying a stale response over listener state", async () => {
    const state = {
      selectedWorkspaceId: "workspace-1",
      sessions: [{id: "session-1", status: "provision_failed", provisioningRetryable: true}],
      api: {
        getSessions: vi.fn(),
        restartSession: vi.fn().mockResolvedValue({
          session: {id: "session-1", status: "running", serviceUrl: "https://stale.example"},
        }),
      },
    };

    await retryProvisioningSessionState(state, "session-1");

    expect(state.api.restartSession).toHaveBeenCalledOnce();
    expect(state.api.restartSession).toHaveBeenCalledWith("workspace-1", "session-1");
    expect(state.api.getSessions).not.toHaveBeenCalled();
    expect(state.sessions[0].status).toBe("provision_failed");
  });
});
