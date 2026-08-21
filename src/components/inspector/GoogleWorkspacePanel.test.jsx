import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {GoogleWorkspacePanel} from "./GoogleWorkspacePanel.jsx";

const account = {
  connectionId: "connection-a",
  email: "a@example.com",
  displayName: "Account A",
  enabledServices: ["gmail"],
  status: "connected",
  workspaceUsage: {count: 1, workspaces: [{id: "workspace-a", name: "Workspace A"}]},
};

function renderPanel(overrides = {}) {
  const props = {
    googleWorkspace: {
      loading: false,
      connecting: false,
      saving: false,
      deleting: false,
      error: "",
      message: "",
      data: {
        binding: {connectionId: "connection-a", enabledServices: ["gmail"]},
        connection: account,
        connections: [account],
        services: [{key: "gmail", displayName: "Gmail", accessLevels: ["read", "write"]}],
      },
    },
    state: {collapsedDrawerSections: new Set()},
    onBindConnection: vi.fn(),
    onDeleteConnection: vi.fn(),
    onEditConnection: vi.fn(),
    onRefresh: vi.fn(),
    onToggleDrawerSection: vi.fn(),
    onUnbindConnection: vi.fn(),
    ...overrides,
  };
  render(<GoogleWorkspacePanel {...props} />);
  return props;
}

describe("GoogleWorkspacePanel", () => {
  test("shows only saved accounts and disables the checked workspace binding", async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    expect(screen.getAllByText("a@example.com")).toHaveLength(1);
    expect(screen.getByText(/1 workspace/)).toBeTruthy();
    expect(screen.queryByText("Workspace services")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Disable a@example.com"}));
    expect(props.onUnbindConnection).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", {name: "Edit a@example.com"}));
    expect(props.onEditConnection).toHaveBeenCalledWith(account);
  });

  test("enables an unplugged saved account with its authorized services", async () => {
    const user = userEvent.setup();
    const onBindConnection = vi.fn();
    renderPanel({
      onBindConnection,
      googleWorkspace: {
        loading: false,
        connecting: false,
        saving: false,
        deleting: false,
        error: "",
        message: "",
        data: {binding: null, connection: null, connections: [account], services: []},
      },
    });

    await user.click(screen.getByRole("button", {name: "Enable a@example.com"}));
    expect(onBindConnection).toHaveBeenCalledWith("connection-a", ["gmail"]);
  });

  test("deletion confirmation names affected workspace count", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onDeleteConnection = vi.fn();
    renderPanel({onDeleteConnection});
    await user.click(screen.getByRole("button", {name: "Remove a@example.com"}));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("used by 1 workspace"));
    expect(onDeleteConnection).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
