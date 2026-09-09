import {createPiPackagesState} from "./initialState.js";

/** Owns every write to the Pi packages domain slice. */
export function createPiPackagesStore(appStore) {
  return {
    getState() {
      return appStore.getState().piPackages;
    },
    update(updater) {
      appStore.updateSlice("piPackages", updater, "piPackages/update");
    },
    reset() {
      appStore.updateSlice("piPackages", createPiPackagesState(), "piPackages/reset");
    },
  };
}
