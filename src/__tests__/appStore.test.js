import {describe, expect, test, vi} from "vitest";
import {APP_ACTIONS, appReducer, createAppStore} from "../state/appStore.js";
import {createInitialState} from "../state/initialState.js";
import {createPiPackagesStore} from "../state/piPackagesStore.js";

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

  test("publishes top-level and Pi package domain transitions", () => {
    const appStore = createAppStore();
    const piPackages = createPiPackagesStore(appStore);
    const listener = vi.fn();
    appStore.subscribe(listener);

    appStore.dispatch({type: APP_ACTIONS.SET_SELECTED_WORKSPACE, workspaceId: "workspace-1"});
    piPackages.update((current) => ({...current, loading: true}));

    expect(piPackages.getState().loading).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("resets the complete Pi package slice through its owner", () => {
    const appStore = createAppStore();
    const piPackages = createPiPackagesStore(appStore);
    piPackages.update((current) => ({...current, data: {packages: ["x"]}, error: "old"}));
    piPackages.reset();
    expect(piPackages.getState()).toMatchObject({data: null, error: "", loading: false});
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
      pendingOperations: {
        refresh: {count: 1, message: "Working...", order: 1},
      },
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
      pendingOperations: {},
      error: "",
    });
  });

  test("keeps overlapping operations pending until each finishes", () => {
    const store = createAppStore(createInitialState());

    store.dispatch({type: APP_ACTIONS.START_OPERATION, key: "refresh", message: "Refreshing..."});
    store.dispatch({type: APP_ACTIONS.START_OPERATION, key: "delete", message: "Deleting..."});
    store.dispatch({type: APP_ACTIONS.START_OPERATION, key: "refresh", message: "Refreshing again..."});

    store.dispatch({type: APP_ACTIONS.END_OPERATION, key: "refresh"});
    expect(store.getState().pendingOperations).toMatchObject({
      refresh: {count: 1},
      delete: {count: 1},
    });

    store.dispatch({type: APP_ACTIONS.END_OPERATION, key: "delete"});
    expect(store.getState().pendingOperations.refresh.count).toBe(1);

    store.dispatch({type: APP_ACTIONS.END_OPERATION, key: "refresh"});
    expect(store.getState().pendingOperations).toEqual({});
  });
});
