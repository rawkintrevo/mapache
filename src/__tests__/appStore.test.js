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
});
