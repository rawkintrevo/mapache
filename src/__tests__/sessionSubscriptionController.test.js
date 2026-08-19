import {describe, expect, test, vi} from "vitest";
import {createSessionSubscriptionController} from "../controllers/sessionSubscriptionController.js";
import {APP_ACTIONS} from "../state/appStore.js";
import {createInitialState} from "../state/initialState.js";

function createFixture() {
  const state = {
    ...createInitialState(),
    selectedWorkspaceId: "workspace-1",
  };
  const listeners = new Map();
  const unsubscribes = [];
  const dispatch = vi.fn((action) => {
    if (action.type === APP_ACTIONS.SET_SELECTED_SESSION) state.selectedSessionId = action.sessionId;
    if (action.type === APP_ACTIONS.SET_ERROR) state.error = action.error;
  });
  const onSelectedSessionChanged = vi.fn();
  const controller = createSessionSubscriptionController({
    state,
    dispatch,
    render: vi.fn(),
    getFirestoreDb: vi.fn(() => ({name: "db"})),
    listenToWorkspaceSessions: vi.fn((_db, workspaceId, onSessions, onError) => {
      listeners.set(workspaceId, {onSessions, onError});
      const unsubscribe = vi.fn();
      unsubscribes.push(unsubscribe);
      return unsubscribe;
    }),
    onSelectedSessionChanged,
  });
  return {state, listeners, unsubscribes, dispatch, onSelectedSessionChanged, controller};
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("sessionSubscriptionController", () => {
  test("replaces the old workspace listener and rejects stale snapshots", async () => {
    const fixture = createFixture();
    const firstLoad = fixture.controller.loadSessions();
    fixture.listeners.get("workspace-1").onSessions([{id: "session-1", serviceUrl: ""}]);
    await firstLoad;
    expect(fixture.state.selectedSessionId).toBe("session-1");

    fixture.state.selectedWorkspaceId = "workspace-2";
    const secondLoad = fixture.controller.loadSessions();
    expect(fixture.unsubscribes[0]).toHaveBeenCalledTimes(1);
    fixture.listeners.get("workspace-1").onSessions([{id: "stale", serviceUrl: "https://stale"}]);
    expect(fixture.state.sessions).toEqual([]);
    fixture.listeners.get("workspace-2").onSessions([{id: "session-2", serviceUrl: "https://runner"}]);
    await secondLoad;

    expect(fixture.state.sessions).toEqual([{id: "session-2", serviceUrl: "https://runner"}]);
    expect(fixture.state.selectedSessionId).toBe("session-2");
  });

  test("auto-selects the first session and refreshes when selection or service URL changes", async () => {
    const fixture = createFixture();
    const load = fixture.controller.loadSessions();
    const listener = fixture.listeners.get("workspace-1");
    listener.onSessions([{id: "session-1", serviceUrl: ""}, {id: "session-2", serviceUrl: ""}]);
    await load;
    await flushPromises();
    expect(fixture.state.selectedSessionId).toBe("session-1");
    expect(fixture.onSelectedSessionChanged).toHaveBeenCalledTimes(1);

    listener.onSessions([{id: "session-1", serviceUrl: "https://runner"}, {id: "session-2", serviceUrl: ""}]);
    listener.onSessions([{id: "session-2", serviceUrl: ""}]);
    await flushPromises();

    expect(fixture.state.selectedSessionId).toBe("session-2");
    expect(fixture.onSelectedSessionChanged).toHaveBeenCalledTimes(3);
  });

  test("ignores errors from a detached workspace listener", async () => {
    const fixture = createFixture();
    const firstLoad = fixture.controller.loadSessions();
    const oldListener = fixture.listeners.get("workspace-1");
    fixture.state.selectedWorkspaceId = "workspace-2";
    const secondLoad = fixture.controller.loadSessions();
    oldListener.onError(new Error("stale_listener_error"));
    expect(fixture.state.error).toBe("");
    fixture.listeners.get("workspace-2").onError(new Error("active_listener_error"));
    await Promise.all([firstLoad, secondLoad]);

    expect(fixture.state.error).toBe("active_listener_error");
  });
});
