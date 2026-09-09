import {describe, expect, test, vi} from "vitest";
import {createPiPanelsController} from "../controllers/piPanelsController.js";
import {createAppStore} from "../state/appStore.js";
import {createPiPackagesStore} from "../state/piPackagesStore.js";

describe("createPiPanelsController", () => {
  test("saves the provider values submitted by the auth modal", async () => {
    const savePiAuthProvider = vi.fn().mockResolvedValue({providers: {}, entries: {}});
    const state = {
      api: {savePiAuthProvider},
      piAuth: {
        selectedProvider: "",
        apiKey: "",
        entryLabel: "",
        saving: false,
        error: "",
        message: "",
        providers: {},
        entries: {},
      },
      sessions: [],
    };
    const appStore = createAppStore(state);
    const controller = createPiPanelsController({
      state: appStore.state,
      piPackagesStore: createPiPackagesStore(appStore),
      render: vi.fn(),
    });

    await controller.savePiAuthProvider("anthropic", "qa-key", "QA entry");

    expect(savePiAuthProvider).toHaveBeenCalledWith("anthropic", "qa-key", "QA entry");
    expect(state.piAuth.error).toBe("");
  });
});
