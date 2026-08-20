import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {GoogleWorkspacePanel} from "./GoogleWorkspacePanel.jsx";

function renderPanel(overrides = {}) {
  const props = {
    googleWorkspace: {
      loading: false,
      connecting: false,
      saving: false,
      deleting: false,
      error: "",
      message: "",
      selectedServices: ["gmail"],
      accessLevel: "read",
      data: {
        binding: {connectionId: "connection-a", enabledServices: ["gmail"]},
        connection: {connectionId: "connection-a", email: "a@example.com"},
        connections: [{
          connectionId: "connection-a",
          email: "a@example.com",
          displayName: "Account A",
          status: "connected",
          workspaceUsage: {count: 1, workspaces: [{id: "workspace-a", name: "Workspace A"}]},
        }],
        services: [{key: "gmail", displayName: "Gmail", accessLevels: ["read", "write"]}],
      },
    },
    selectedSession: {id: "session-a", status: "running"},
    state: {collapsedDrawerSections: new Set()},
    onBindConnection: vi.fn(),
    onDeleteConnection: vi.fn(),
    onRefresh: vi.fn(),
    onRestartSession: vi.fn(),
    onStartConnection: vi.fn(),
    onToggleDrawerSection: vi.fn(),
    onUnbindConnection: vi.fn(),
    onUpdateAccessLevel: vi.fn(),
    onUpdateService: vi.fn(),
    ...overrides,
  };
  return render(<GoogleWorkspacePanel {...props} />);
}

describe("GoogleWorkspacePanel", () => {
  test("shows the bound account, workspace usage, service control, and restart action", async () => {
    const user = userEvent.setup();
    const onUpdateService = vi.fn();
    const onRestartSession = vi.fn();
    const onStartConnection = vi.fn();
    renderPanel({
      onUpdateService,
      onRestartSession,
      onStartConnection,
      googleWorkspace: {
        loading: false,
        connecting: false,
        saving: false,
        deleting: false,
        error: "",
        message: "Google services applied. Restart active sessions to load the new MCP servers.",
        selectedServices: ["gmail"],
        accessLevel: "read",
        data: {
          binding: {connectionId: "connection-a", enabledServices: ["gmail"]},
          connection: {connectionId: "connection-a", email: "a@example.com"},
          connections: [{
            connectionId: "connection-a",
            email: "a@example.com",
            displayName: "Account A",
            status: "connected",
            workspaceUsage: {count: 1, workspaces: [{id: "workspace-a", name: "Workspace A"}]},
          }],
          services: [{key: "gmail", displayName: "Gmail", accessLevels: ["read", "write"]}],
        },
      },
    });
    expect(screen.getAllByText("a@example.com").length).toBe(2);
    expect(screen.getByText(/1 workspace/)).toBeTruthy();
    expect(screen.getByRole("button", {name: "Restart active session"})).toBeTruthy();
    await user.click(screen.getByRole("checkbox"));
    expect(onUpdateService).toHaveBeenCalledWith("gmail", false);
    await user.click(screen.getByRole("button", {name: "Restart active session"}));
    expect(onRestartSession).toHaveBeenCalledWith("session-a");
    await user.click(screen.getByRole("button", {name: "Reconnect / change account"}));
    expect(onStartConnection).toHaveBeenCalledWith({reconnect: true});
  });

  test("deletion confirmation names affected workspace count", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onDeleteConnection = vi.fn();
    renderPanel({onDeleteConnection});
    expect(screen.getByText(/1 workspace/)).toBeTruthy();
    await user.click(screen.getByRole("button", {name: "Remove a@example.com"}));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("used by 1 workspace"));
    expect(onDeleteConnection).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
