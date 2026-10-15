import {render, screen, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {Topbar} from "./Topbar.jsx";
import {createInitialState} from "../../state/initialState.js";

function renderTopbar(session = null, resourceMetrics = null, workspaceOverrides = {}) {
  const state = {
    ...createInitialState(),
    workspaces: [{id: "workspace-1", name: "HubSpot", source: {type: "blank"}, canonicalSessionId: session?.id || null, ...workspaceOverrides}],
    selectedWorkspaceId: "workspace-1",
    sessions: session ? [session] : [],
  };
  const onToggleWorkspace = vi.fn();
  const onOpenPiAuthManage = vi.fn();
  const onOpenGenericEnvironment = vi.fn();
  const onOpenGoogleWorkspace = vi.fn();
  const onOpenMcpServers = vi.fn();
  const onShowAutomations = vi.fn();
  const onShowUpload = vi.fn();
  const onSetRuntimePolicy = vi.fn();
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
      onShowAutomations={onShowAutomations}
      onShowUpload={onShowUpload}
      onShowLogs={vi.fn()}
      onShowProfile={vi.fn()}
      onSignOut={vi.fn()}
      onSetRuntimePolicy={onSetRuntimePolicy}
      onToggleWorkspace={onToggleWorkspace}
      resourceMetrics={resourceMetrics}
    />,
  );
  return {
    onOpenGenericEnvironment,
    onOpenGoogleWorkspace,
    onOpenMcpServers,
    onOpenPiAuthManage,
    onSetRuntimePolicy,
    onShowAutomations,
    onShowUpload,
    onToggleWorkspace,
  };
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
  expect(screen.queryByRole("group", {name: "Runtime policy"})).not.toBeInTheDocument();
  });

test("shows the runtime policy for a marked workspace before its first session", () => {
  renderTopbar(null, null, {agentUiVersion: "pi-web-ui-v1"});
  expect(screen.getByRole("group", {name: "Runtime policy"})).toBeInTheDocument();
});
});

test("uses one automation navigation entry for definitions and run history", async () => {
  const user = userEvent.setup();
  const {onShowAutomations} = renderTopbar();

  const automationsButton = screen.getByRole("button", {name: "Automations"});
  expect(automationsButton).toBeEnabled();
  expect(automationsButton).toHaveAttribute("title", "Automations");
  expect(screen.queryByRole("button", {name: "Run history"})).not.toBeInTheDocument();
  automationsButton.focus();
  await user.keyboard("{Enter}");
  expect(onShowAutomations).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", {name: "More workspace actions"}));
  expect(screen.getByRole("menuitem", {name: "Automations"})).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", {name: "Run history"})).not.toBeInTheDocument();
  screen.getByRole("menuitem", {name: "Automations"}).focus();
  await user.keyboard("{Enter}");
  expect(onShowAutomations).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("opens labeled secondary actions from the More menu", async () => {
  const user = userEvent.setup();
  const onOpenWorkspaceModal = vi.fn();
  const onOpenRequestGrants = vi.fn();
  const state = {
    ...createInitialState(),
    workspaces: [{id: "workspace-1", name: "A very long workspace name", source: {type: "blank"}}],
    selectedWorkspaceId: "workspace-1",
  };
  render(<Topbar state={state} onDeleteWorkspace={vi.fn()} onOpenGenericEnvironment={vi.fn()} onOpenGoogleWorkspace={vi.fn()} onOpenMcpServers={vi.fn()} onOpenRequestGrants={onOpenRequestGrants} onOpenPiAuthManage={vi.fn()} onOpenWorkspaceEditModal={vi.fn()} onOpenWorkspaceModal={onOpenWorkspaceModal} onRefresh={vi.fn()} onSelectWorkspace={vi.fn()} onShowAdmin={vi.fn()} onShowLogs={vi.fn()} onShowProfile={vi.fn()} onSignOut={vi.fn()} onToggleWorkspace={vi.fn()} />);
  await user.click(screen.getByRole("button", {name: "More workspace actions"}));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.getByRole("menuitem", {name: "Create workspace"})).toBeInTheDocument();
  expect(screen.getByRole("menuitem", {name: "Delete workspace A very long workspace name"})).toHaveClass("topbar-more-item--destructive");
  expect(screen.getByRole("menuitem", {name: "Workspace request access"})).toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", {name: "Workspace request access"}));
  expect(onOpenRequestGrants).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", {name: "More workspace actions"}));
  await user.click(screen.getByRole("menuitem", {name: "Create workspace"}));
  expect(onOpenWorkspaceModal).toHaveBeenCalledOnce();
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

test("lets users select and save a scheduled runtime policy", async () => {
  const user = userEvent.setup();
  const {onSetRuntimePolicy} = renderTopbar({
    id: "session-1",
    status: "running",
    agentUiVersion: "pi-web-ui-v1",
    idleTimeoutMinutes: 60,
    longRunning: false,
  });

  const policy = screen.getByRole("group", {name: "Runtime policy"});
  await user.click(within(policy).getByRole("button", {name: /Idle timeout/}));
  await user.selectOptions(within(policy).getByRole("combobox", {name: "Runtime policy mode"}), "scheduled");
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
    await user.click(within(policy).getByRole("button", {name: day}));
  }
  await user.clear(within(policy).getByRole("textbox", {name: "Schedule time zone"}));
  await user.type(within(policy).getByRole("textbox", {name: "Schedule time zone"}), "America/Chicago");
  await user.type(within(policy).getByLabelText("Schedule start time"), "08:00");
  await user.type(within(policy).getByLabelText("Schedule end time"), "18:00");
  expect(within(policy).getByText(/active agent turns and shell jobs are interrupted/i)).toBeInTheDocument();
  await user.click(within(policy).getByRole("button", {name: "Save policy"}));

  expect(onSetRuntimePolicy).toHaveBeenCalledWith(expect.objectContaining({
    mode: "scheduled",
    schedule: expect.objectContaining({days: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "18:00", timezone: "America/Chicago"}),
  }));
});

test("does not show the runtime policy editor for historical sessions", () => {
  renderTopbar({id: "session-1", status: "running"});
  expect(screen.queryByRole("group", {name: "Runtime policy"})).not.toBeInTheDocument();
});

test("upload is available before starting a workspace and in the More menu", async () => {
  const user = userEvent.setup();
  const {onShowUpload} = renderTopbar();
  await user.click(screen.getByRole("button", {name: "Upload file"}));
  expect(onShowUpload).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", {name: "More workspace actions"}));
  await user.click(screen.getByRole("menuitem", {name: "Upload file"}));
  expect(onShowUpload).toHaveBeenCalledTimes(2);
});
