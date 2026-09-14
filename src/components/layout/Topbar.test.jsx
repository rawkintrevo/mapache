import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {Topbar} from "./Topbar.jsx";
import {createInitialState} from "../../state/initialState.js";

function renderTopbar(session = null, resourceMetrics = null) {
  const state = {
    ...createInitialState(),
    workspaces: [{id: "workspace-1", name: "HubSpot", source: {type: "blank"}, canonicalSessionId: session?.id || null}],
    selectedWorkspaceId: "workspace-1",
    sessions: session ? [session] : [],
  };
  const onToggleWorkspace = vi.fn();
  const onOpenPiAuthManage = vi.fn();
  const onOpenGenericEnvironment = vi.fn();
  const onOpenGoogleWorkspace = vi.fn();
  const onOpenMcpServers = vi.fn();
  render(
    <Topbar
      state={state}
      onDeleteWorkspace={vi.fn()}
      onOpenGenericEnvironment={onOpenGenericEnvironment}
      onOpenGoogleWorkspace={onOpenGoogleWorkspace}
      onOpenMcpServers={onOpenMcpServers}
      onOpenPiAuthManage={onOpenPiAuthManage}
      onOpenWorkspaceEditModal={vi.fn()}
      onOpenWorkspaceModal={vi.fn()}
      onRefresh={vi.fn()}
      onSelectCanvas={vi.fn()}
      onSelectWorkspace={vi.fn()}
      onShowAdmin={vi.fn()}
      onShowLogs={vi.fn()}
      onShowProfile={vi.fn()}
      onSignOut={vi.fn()}
      onToggleWorkspace={onToggleWorkspace}
      resourceMetrics={resourceMetrics}
    />,
  );
  return {onOpenGenericEnvironment, onOpenGoogleWorkspace, onOpenMcpServers, onOpenPiAuthManage, onToggleWorkspace};
}

describe("Topbar workspace lifecycle", () => {
  test("starts an off workspace", async () => {
    const user = userEvent.setup();
    const {onToggleWorkspace} = renderTopbar({id: "session-1", status: "stopped"});
    await user.click(screen.getByRole("button", {name: "Start workspace"}));
    expect(onToggleWorkspace).toHaveBeenCalledOnce();
  });

  test("opens Pi auth, environment, MCP, and Google Workspace management from icon buttons", async () => {
    const user = userEvent.setup();
    const handlers = renderTopbar({id: "session-1", status: "running", terminalKind: "pi"});

    const piAuthButton = screen.getByRole("button", {name: "Manage Pi Auth"});
    const environmentButton = screen.getByRole("button", {name: "Manage generic environment keys"});
    const mcpButton = screen.getByRole("button", {name: "Manage MCP servers"});
    const googleButton = screen.getByRole("button", {name: "Manage Google Workspace"});
    expect(piAuthButton).toHaveAttribute("title", "Manage Pi Auth");
    expect(environmentButton).toHaveAttribute("title", "Manage generic environment keys");
    expect(mcpButton).toHaveAttribute("title", "Manage MCP servers");
    expect(googleButton).toHaveAttribute("title", "Manage Google Workspace");

    await user.click(piAuthButton);
    await user.click(environmentButton);
    await user.click(mcpButton);
    await user.click(googleButton);
    expect(handlers.onOpenPiAuthManage).toHaveBeenCalledOnce();
    expect(handlers.onOpenGenericEnvironment).toHaveBeenCalledOnce();
    expect(handlers.onOpenMcpServers).toHaveBeenCalledOnce();
    expect(handlers.onOpenGoogleWorkspace).toHaveBeenCalledOnce();
  });

  test("pauses a running workspace", () => {
    renderTopbar({id: "session-1", status: "running"});
    expect(screen.getByRole("button", {name: "Pause workspace"})).toBeEnabled();
  });

  test("starts a workspace with no existing session", () => {
    renderTopbar();
    expect(screen.getByRole("button", {name: "Start workspace"})).toBeEnabled();
  });
});

test("disables lifecycle actions while an asynchronous resize is queued", () => {
  renderTopbar({id: "session-1", status: "running", resizeOperationState: "queued"});
  expect(screen.getByRole("button", {name: "Pause workspace"})).toBeDisabled();
});

test("renders live resource meters between workspace controls and actions", () => {
  renderTopbar(
      {id: "session-1", status: "running"},
      {connectionState: "connected", sample: {
        type: "metrics",
        sampledAt: 1700000000000,
        cpu: {percent: 42.5, limitCores: 2},
        memory: {usedBytes: 1073741824, limitBytes: 2147483648, percent: 50},
      }},
  );

  const utilization = screen.getByLabelText("Resource utilization");
  expect(utilization).toHaveClass("resource-utilization--navbar");
  expect(screen.getByText("43%")).toBeInTheDocument();
  expect(screen.getByText("1 GiB/2 GiB")).toBeInTheDocument();
});
