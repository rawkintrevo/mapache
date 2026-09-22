import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {GoogleWorkspaceManageModal} from "./GoogleWorkspaceManageModal.jsx";

const account = {
  connectionId: "connection-a",
  email: "a@example.com",
  displayName: "Account A",
  enabledServices: ["gmail"],
  status: "connected",
  workspaceUsage: {count: 1, workspaces: [{id: "workspace-a", name: "Workspace A"}]},
};

function renderModal(overrides = {}) {
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
        connections: [account],
      },
    },
    onBindConnection: vi.fn(),
    onClose: vi.fn(),
    onDeleteConnection: vi.fn(),
    onEditConnection: vi.fn(),
    onRefresh: vi.fn(),
    onUnbindConnection: vi.fn(),
    ...overrides,
  };
  render(<GoogleWorkspaceManageModal {...props} />);
  return props;
}

describe("GoogleWorkspaceManageModal", () => {
  test("manages the selected workspace binding and account editor", async () => {
    const user = userEvent.setup();
    const props = renderModal();

    expect(screen.getByRole("dialog", {name: "Google Workspace"})).toBeInTheDocument();
    expect(screen.getByText(/Authorized/)).toBeInTheDocument();
    expect(screen.queryByText(/^Ready$/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 workspace/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Disable a@example.com"}));
    expect(props.onUnbindConnection).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", {name: "Edit a@example.com"}));
    expect(props.onEditConnection).toHaveBeenCalledWith(account);
  });

  test("enables an unplugged saved account with its authorized services", async () => {
    const user = userEvent.setup();
    const onBindConnection = vi.fn();
    renderModal({
      onBindConnection,
      googleWorkspace: {
        loading: false,
        connecting: false,
        saving: false,
        deleting: false,
        error: "",
        message: "",
        data: {binding: null, connections: [account]},
      },
    });

    await user.click(screen.getByRole("button", {name: "Enable a@example.com"}));
    expect(onBindConnection).toHaveBeenCalledWith("connection-a", ["gmail"]);
  });

  test("deletion confirmation names the affected workspace count", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onDeleteConnection = vi.fn();
    renderModal({onDeleteConnection});
    await user.click(screen.getByRole("button", {name: "Remove a@example.com"}));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("used by 1 workspace"));
    expect(onDeleteConnection).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
