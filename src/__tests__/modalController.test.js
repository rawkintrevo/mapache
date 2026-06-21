import {describe, expect, test, vi} from "vitest";
import {createModalController} from "../controllers/modalController.js";

describe("createModalController", () => {
  test("ignores the click event when opening the add-auth modal", () => {
    const state = {authModalOpen: false, piAuth: {selectedProvider: "anthropic"}};
    const controller = createModalController({state, render: vi.fn(), loadPiAuth: vi.fn()});

    controller.openAuthModal({type: "click"});

    expect(state.authModalOpen).toBe(true);
    expect(state.piAuth.selectedProvider).toBe("anthropic");
  });

  test("preselects a provider when reopening OAuth login", () => {
    const state = {authModalOpen: false, piAuth: {selectedProvider: "anthropic", error: "old"}};
    const controller = createModalController({state, render: vi.fn(), loadPiAuth: vi.fn()});

    controller.openAuthModal("openai-codex");

    expect(state.piAuth.selectedProvider).toBe("openai-codex");
    expect(state.piAuth.error).toBe("");
  });
});
