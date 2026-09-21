import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {createInitialState} from "../../state/initialState.js";
import {AutomationsPanel} from "./AutomationsPanel.jsx";

function fixture(overrides = {}) {
  const state = createInitialState();
  state.selectedWorkspaceId = "workspace-1";
  state.workspaces = [{id: "workspace-1", name: "Demo", canonicalSessionId: "session-1", sharedStorage: {state: "legacy"}}];
  state.sessions = [{id: "session-1", status: "stopped"}];
  state.automations = {
    ...state.automations,
    selectedWorkspaceId: "workspace-1",
    ...overrides.automations,
  };
  return state;
}

function renderPanel(state, overrides = {}) {
  return render(<AutomationsPanel
    onCreateDefinition={vi.fn().mockResolvedValue({id: "new"})}
    onDeleteDefinition={vi.fn()}
    onLoadHistory={vi.fn()}
    onLoadWorkspace={vi.fn()}
    onOpenHistory={vi.fn()}
    onPrepareStorage={vi.fn()}
    onPreviewSchedule={vi.fn().mockResolvedValue({occurrences: []})}
    onRunNow={vi.fn()}
    onShowWorkspace={vi.fn()}
    onUpdateDefinition={vi.fn()}
    onUpdateSettings={vi.fn()}
    state={state}
    {...overrides}
  />);
}

describe("AutomationsPanel", () => {
  test("shows storage preparation and does not enable run actions before ready", async () => {
    const user = userEvent.setup();
    const state = fixture({automations: {storageState: "legacy", definitions: [{id: "a1", name: "Daily", cron: "0 9 * * *", timezone: "UTC", enabled: false} ]}});
    renderPanel(state);

    expect(screen.getByRole("button", {name: "Prepare automations"})).toBeInTheDocument();
    expect(screen.getByText(/Usage-based storage/)).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Run now"})).toBeDisabled();
    await user.click(screen.getByRole("button", {name: "New automation"}));
    expect(screen.getByRole("heading", {name: "New automation"})).toBeInTheDocument();
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toBeDisabled();
  });

  test("updates concurrency and retains queued reason in the workflow list", async () => {
    const user = userEvent.setup();
    const onUpdateSettings = vi.fn().mockResolvedValue({automationMaxConcurrency: 3});
    const state = fixture({automations: {
      storageState: "ready",
      maxConcurrency: 1,
      definitions: [{id: "a1", name: "Daily", cron: "0 9 * * *", timezone: "UTC", enabled: true}],
      history: {loading: false, error: "", runs: [{automationId: "a1", status: "queued", skippedReason: "waiting_for_main"}], filters: {}, nextCursor: "", cursor: ""},
    }});
    renderPanel(state, {onUpdateSettings});

    expect(screen.getByText(/queued · waiting_for_main/)).toBeInTheDocument();
    await user.clear(screen.getByRole("spinbutton", {name: "Maximum concurrent automations"}));
    await user.type(screen.getByRole("spinbutton", {name: "Maximum concurrent automations"}), "3");
    await user.click(screen.getByRole("button", {name: "Save limit"}));
    expect(onUpdateSettings).toHaveBeenCalledWith({automationMaxConcurrency: 3}, "workspace-1");
  });

  test("shows an existing prepared workspace bucket as ready even with stale legacy state", () => {
    const state = fixture({
      automations: {storageState: "legacy"},
    });
    state.workspaces[0] = {
      ...state.workspaces[0],
      sharedStorageState: "legacy",
      sharedStorage: {
        state: "ready",
        bucketName: "backend-owned",
        storageGeneration: "generation-7",
      },
    };
    renderPanel(state);

    expect(screen.getByRole("heading", {name: "Ready"})).toBeInTheDocument();
    expect(screen.getByText(/Existing backend-owned shared storage is ready/)).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Storage ready"})).toBeDisabled();
    expect(screen.queryByRole("button", {name: "Prepare automations"})).not.toBeInTheDocument();
  });
});
