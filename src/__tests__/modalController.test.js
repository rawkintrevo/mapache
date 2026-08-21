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

  test("opens an existing entry for editing and returns to auth management", () => {
    const state = {
      authModalOpen: false,
      authReturnToManage: false,
      piAuthManageModalOpen: true,
      piAuth: {selectedProvider: "anthropic", error: "old"},
    };
    const controller = createModalController({state, render: vi.fn(), loadPiAuth: vi.fn()});

    controller.openAuthModal({id: "entry-1", providerKey: "openai", label: "Work OpenAI"});

    expect(state.piAuthManageModalOpen).toBe(false);
    expect(state.authModalOpen).toBe(true);
    expect(state.piAuth).toMatchObject({editEntryId: "entry-1", selectedProvider: "openai", entryLabel: "Work OpenAI"});

    controller.closeAuthModal();
    expect(state.authModalOpen).toBe(false);
    expect(state.piAuthManageModalOpen).toBe(true);
  });
});
