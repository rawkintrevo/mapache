import {render, screen} from "@testing-library/react";
import {describe, expect, test, vi} from "vitest";
import {createInitialState} from "../../state/initialState.js";
import {AutomationManagementPage} from "./AutomationManagementPage.jsx";

function createState() {
  const state = createInitialState();
  state.selectedWorkspaceId = "workspace-1";
  state.workspaces = [{id: "workspace-1", name: "Writing", sharedStorage: {configured: true, state: "ready", errorCode: null}}];
  state.automations = {
    ...state.automations,
    globalHistory: {...state.automations.globalHistory, runs: []},
  };
  return state;
}

function createProps() {
  return {
    onCreateDefinition: vi.fn(),
    onDeleteDefinition: vi.fn(),
    onLoadEvents: vi.fn(),
    onLoadGlobalHistory: vi.fn(),
    onLoadHistory: vi.fn(),
    onLoadNextGlobalHistoryPage: vi.fn(),
    onLoadWorkspace: vi.fn(),
    onOpenHistory: vi.fn(),
    onPrepareStorage: vi.fn(),
    onPreviewSchedule: vi.fn(),
    onOpenModelSettings: vi.fn(),
    onRestartRun: vi.fn(),
    onRunNow: vi.fn(),
    onSelectRun: vi.fn(),
    onSetGlobalHistoryFilters: vi.fn(),
    onShowWorkspace: vi.fn(),
    onStopRun: vi.fn(),
    onUpdateDefinition: vi.fn(),
    onUpdateSettings: vi.fn(),
  };
}

describe("AutomationManagementPage", () => {
  test("renders definitions and global run history together", async () => {
    const props = createProps();
    render(<AutomationManagementPage {...props} state={createState()} />);

    expect(screen.getByRole("heading", {name: "Automations"})).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "New automation"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Run history"})).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Apply filters"})).toBeInTheDocument();
    expect(props.onLoadWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(props.onLoadHistory).toHaveBeenCalledWith({workspaceId: "workspace-1", filters: {workspaceId: "workspace-1"}});
    expect(props.onLoadGlobalHistory).toHaveBeenCalledOnce();
  });
});
