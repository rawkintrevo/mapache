import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {Topbar} from "./Topbar.jsx";
import {createInitialState} from "../../state/initialState.js";

function renderTopbar(session = null) {
  const state = {
    ...createInitialState(),
    workspaces: [{id: "workspace-1", name: "HubSpot", source: {type: "blank"}, canonicalSessionId: session?.id || null}],
    selectedWorkspaceId: "workspace-1",
    sessions: session ? [session] : [],
  };
  const onToggleWorkspace = vi.fn();
  const onOpenPiAuthManage = vi.fn();
  const onOpenGenericEnvironment = vi.fn();
  render(
    <Topbar
      state={state}
      onDeleteWorkspace={vi.fn()}
      onOpenGenericEnvironment={onOpenGenericEnvironment}
      onOpenPiAuthManage={onOpenPiAuthManage}
      onOpenWorkspaceEditModal={vi.fn()}
      onOpenWorkspaceModal={vi.fn()}
      onRefresh={vi.fn()}
      onSelectWorkspace={vi.fn()}
      onToggleWorkspace={onToggleWorkspace}
    />,
  );
  return {onOpenGenericEnvironment, onOpenPiAuthManage, onToggleWorkspace};
}

describe("Topbar workspace lifecycle", () => {
  test("starts an off workspace", async () => {
    const user = userEvent.setup();
    const {onToggleWorkspace} = renderTopbar({id: "session-1", status: "stopped"});
    await user.click(screen.getByRole("button", {name: "Start workspace"}));
    expect(onToggleWorkspace).toHaveBeenCalledOnce();
  });

  test("opens Pi auth and generic environment management from icon buttons", async () => {
    const user = userEvent.setup();
    const handlers = renderTopbar({id: "session-1", status: "running", terminalKind: "pi"});

    const piAuthButton = screen.getByRole("button", {name: "Manage Pi Auth"});
    const environmentButton = screen.getByRole("button", {name: "Manage generic environment keys"});
    expect(piAuthButton).toHaveAttribute("title", "Manage Pi Auth");
    expect(environmentButton).toHaveAttribute("title", "Manage generic environment keys");

    await user.click(piAuthButton);
    await user.click(environmentButton);
    expect(handlers.onOpenPiAuthManage).toHaveBeenCalledOnce();
    expect(handlers.onOpenGenericEnvironment).toHaveBeenCalledOnce();
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
