import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {AuthCenterPanel} from "../components/inspector/AuthCenterPanel.jsx";

function renderPanel(overrides = {}) {
  const props = {
    piAuth: {
      loading: false,
      saving: false,
      entries: {
        "entry-oauth": {
          providerKey: "openai-codex",
          label: "My Pi login",
          credential: {type: "oauth", access: "secret"},
        },
      },
      providers: {},
    },
    selectedSession: null,
    state: {collapsedSections: {}},
    onDeletePiAuthProvider: vi.fn(),
    onOpenAuthModal: vi.fn(),
    onRefreshPiAuth: vi.fn(),
    onToggleDrawerSection: vi.fn(),
    ...overrides,
  };
  render(<AuthCenterPanel {...props} />);
  return props;
}

describe("AuthCenterPanel", () => {
  test("deletes an auth entry by its entry id", async () => {
    const props = renderPanel();
    await userEvent.click(screen.getByRole("button", {name: "Delete My Pi login"}));
    expect(props.onDeletePiAuthProvider).toHaveBeenCalledWith("entry-oauth");
  });

  test("restarts login for an OAuth entry's provider", async () => {
    const props = renderPanel();
    await userEvent.click(screen.getByRole("button", {name: "Log in again for My Pi login"}));
    expect(props.onOpenAuthModal).toHaveBeenCalledWith("openai-codex");
  });
});
