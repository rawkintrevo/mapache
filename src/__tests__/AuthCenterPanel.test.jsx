import {render, screen} from "@testing-library/react";
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
    state: {collapsedSections: {}},
    onRefreshPiAuth: vi.fn(),
    onToggleDrawerSection: vi.fn(),
    ...overrides,
  };
  render(<AuthCenterPanel {...props} />);
  return props;
}

describe("AuthCenterPanel", () => {
  test("keeps provider actions and configured entries out of the inspector", () => {
    renderPanel();
    expect(screen.queryByRole("button", {name: "Manage Pi Auth"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Manage generic environment keys"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Add authentication provider"})).not.toBeInTheDocument();
    expect(screen.queryByText("My Pi login")).not.toBeInTheDocument();
  });
});
