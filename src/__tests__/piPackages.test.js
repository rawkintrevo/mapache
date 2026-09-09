import {describe, expect, test, vi} from "vitest";
import {createAppStore} from "../state/appStore.js";
import {createInitialState} from "../state/initialState.js";
import {createPiPackagesStore} from "../state/piPackagesStore.js";
import {installPiPackageState} from "../workflows/piPackages.js";

function createPackageContext(api) {
  const appStore = createAppStore({
    ...createInitialState(),
    api,
    selectedWorkspaceId: "workspace-1",
    selectedSessionId: "session-1",
  });
  return {
    state: appStore.state,
    piPackagesStore: createPiPackagesStore(appStore),
  };
}

describe("Pi package workflow", () => {
  test("returns success after installing and refreshing the package list", async () => {
    const api = {installPiPackage: vi.fn().mockResolvedValue({ok: true})};
    const {state, piPackagesStore} = createPackageContext(api);
    const loadPiPackages = vi.fn().mockResolvedValue(undefined);

    const result = await installPiPackageState({
      state,
      piPackagesStore,
      source: "npm:@mapache/example",
      loadPiPackages,
    });

    expect(result).toBe(true);
    expect(api.installPiPackage).toHaveBeenCalledWith("workspace-1", "session-1", "npm:@mapache/example");
    expect(loadPiPackages).toHaveBeenCalledTimes(1);
    expect(piPackagesStore.getState()).toMatchObject({
      installing: false,
      installSource: "",
      installMessage: "Package installed into this workspace.",
    });
  });

  test("returns failure when installation is rejected", async () => {
    const api = {installPiPackage: vi.fn().mockRejectedValue(new Error("runner_busy_or_unavailable"))};
    const {state, piPackagesStore} = createPackageContext(api);

    const result = await installPiPackageState({
      state,
      piPackagesStore,
      source: "git:https://github.com/example/package.git",
      loadPiPackages: vi.fn(),
    });

    expect(result).toBe(false);
    expect(piPackagesStore.getState()).toMatchObject({
      installing: false,
      installMessage: "",
    });
    expect(piPackagesStore.getState().error).toBeTruthy();
  });
});
