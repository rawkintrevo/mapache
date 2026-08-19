import {describe, expect, test, vi} from "vitest";
import {APP_ACTIONS, appReducer, createAppStore} from "../state/appStore.js";
import {createInitialState} from "../state/initialState.js";

describe("appStore", () => {
  test("returns immutable reducer results for top-level transitions", () => {
    const initialState = createInitialState();
    const nextState = appReducer(initialState, {
      type: APP_ACTIONS.SET_SELECTED_WORKSPACE,
      workspaceId: "workspace-1",
    });

    expect(nextState).not.toBe(initialState);
    expect(nextState.selectedWorkspaceId).toBe("workspace-1");
    expect(initialState.selectedWorkspaceId).toBeNull();
  });

  test("publishes identity, selection, and busy/error transitions", () => {
    const store = createAppStore(createInitialState());
    const listener = vi.fn();
    store.subscribe(listener);
    const user = {uid: "user-1"};
    const api = {getMe: vi.fn()};

    store.dispatch({type: APP_ACTIONS.SET_IDENTITY, user, api});
    store.dispatch({type: APP_ACTIONS.SET_SELECTED_WORKSPACE, workspaceId: "workspace-1"});
    store.dispatch({type: APP_ACTIONS.SET_SELECTED_SESSION, sessionId: "session-1"});
    store.dispatch({type: APP_ACTIONS.SET_ACTIVE_PAGE, page: "profile"});
    store.dispatch({type: APP_ACTIONS.SET_BUSY, busy: true, message: "Refreshing..."});
    store.dispatch({type: APP_ACTIONS.SET_ERROR, error: "network"});

    expect(store.getState()).toMatchObject({
      user,
      api,
      selectedWorkspaceId: "workspace-1",
      selectedSessionId: "session-1",
      activePage: "profile",
      busy: true,
      busyMessage: "Refreshing...",
      error: "network",
    });
    expect(listener).toHaveBeenCalledTimes(6);
  });

  test("resets authenticated top-level state when signed out", () => {
    const store = createAppStore({
      ...createInitialState(),
      user: {uid: "user-1"},
      profile: {uid: "user-1"},
      api: {getMe: vi.fn()},
      selectedWorkspaceId: "workspace-1",
      selectedSessionId: "session-1",
      activePage: "admin",
      busy: true,
      busyMessage: "Working...",
      error: "old error",
    });

    store.dispatch({type: APP_ACTIONS.RESET_SIGNED_OUT});

    expect(store.getState()).toMatchObject({
      user: null,
      profile: null,
      api: null,
      selectedWorkspaceId: null,
      selectedSessionId: null,
      activePage: "workspace",
      busy: false,
      busyMessage: "",
      error: "",
    });
  });
});
