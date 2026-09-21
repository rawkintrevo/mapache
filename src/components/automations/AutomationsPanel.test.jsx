import {act, fireEvent, render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, describe, expect, test, vi} from "vitest";
import {createInitialState} from "../../state/initialState.js";
import {AutomationsPanel} from "./AutomationsPanel.jsx";

afterEach(() => vi.useRealTimers());

function fixture(overrides = {}) {
  const state = createInitialState();
  state.selectedWorkspaceId = "workspace-1";
  state.workspaces = [{id: "workspace-1", name: "Demo", canonicalSessionId: "session-1", sharedStorage: {configured: false, state: "legacy", errorCode: null}}];
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
  test("enables a ready definition and leaves Disable available when storage is lost", async () => {
    const user = userEvent.setup();
    const definition = {id: "a1", name: "Daily", cron: "0 9 * * *", timezone: "UTC", enabled: false, modelSelection: {modelId: "configured"}};
    const state = fixture({automations: {definitions: [definition]}});
    state.workspaces[0].sharedStorage = {configured: true, state: "ready", errorCode: null};
    const onUpdateDefinition = vi.fn();
    const view = render(<AutomationsPanel state={state} onUpdateDefinition={onUpdateDefinition} />);
    await user.click(screen.getByRole("button", {name: "Enable"}));
    expect(onUpdateDefinition).toHaveBeenLastCalledWith("a1", {enabled: true}, "workspace-1");
    state.automations.definitions = [{...definition, enabled: true}];
    state.workspaces[0].sharedStorage = {configured: true, state: "error", errorCode: "validation_failed"};
    state.automations.busy = true;
    state.automations.busyAction = "storage";
    state.automations.pendingActions = [{action: "storage"}];
    view.rerender(<AutomationsPanel state={state} onUpdateDefinition={onUpdateDefinition} />);
    expect(screen.getByRole("button", {name: "Disable"})).toBeEnabled();
    await user.click(screen.getByRole("button", {name: "Disable"}));
    expect(onUpdateDefinition).toHaveBeenLastCalledWith("a1", {enabled: false}, "workspace-1");
    state.automations.pendingActions = [{action: "update", automationId: "a1"}];
    state.automations.busyAction = "update";
    view.rerender(<AutomationsPanel state={state} onUpdateDefinition={onUpdateDefinition} />);
    expect(screen.getByRole("button", {name: "Disable"})).toBeDisabled();
  });

  test("unlocks list and editor from a reconciled public summary without losing draft values", async () => {
    const user = userEvent.setup();
    const state = fixture({automations: {definitions: [{id: "a1", name: "Daily", cron: "0 9 * * *", timezone: "UTC", enabled: false}]}});
    state.workspaces[0].sharedStorage = {configured: true, state: "legacy", errorCode: null};
    state.workspaces[0].modelSelection = {modelId: "configured"};
    const onPrepareStorage = vi.fn();
    const onShowWorkspace = vi.fn();
    const props = {state, onPrepareStorage, onShowWorkspace};
    const view = render(<AutomationsPanel {...props} />);
    expect(screen.getByRole("button", {name: "Enable"})).toHaveAccessibleDescription(/needs validation/);
    await user.click(screen.getByRole("button", {name: "Revalidate shared storage"}));
    expect(onPrepareStorage).toHaveBeenCalledWith("workspace-1");
    state.workspaces[0].sharedStorage = {configured: true, state: "ready", errorCode: null};
    view.rerender(<AutomationsPanel {...props} />);
    expect(screen.getByRole("button", {name: "Enable"})).toBeEnabled();
    await user.click(screen.getByRole("button", {name: "New automation"}));
    await user.type(screen.getByRole("textbox", {name: /^Name/}), "Retain my draft");
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toBeEnabled();
    state.workspaces[0].sharedStorage.state = "error";
    state.workspaces[0].sharedStorage.errorCode = "bucket_missing";
    view.rerender(<AutomationsPanel {...props} />);
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toBeDisabled();
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toHaveAccessibleDescription(/validation failed.*bucket_missing/);
    expect(screen.getByRole("textbox", {name: /^Name/})).toHaveValue("Retain my draft");
  });

  test("explains missing models and provides a working return to Agent without a conflict banner", async () => {
    const user = userEvent.setup();
    const state = fixture({automations: {error: "missing_model_selection", definitions: [{id: "a1", name: "Daily"}]}});
    state.workspaces[0].sharedStorage = {configured: true, state: "ready", errorCode: null};
    const onOpenModelSettings = vi.fn();
    renderPanel(state, {onOpenModelSettings});
    expect(screen.getByRole("button", {name: "Enable"})).toHaveAccessibleDescription(/Agent settings/);
    expect(screen.queryByText(/changed elsewhere/)).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", {name: "Back to Agent"})[0]);
    expect(onOpenModelSettings).toHaveBeenCalledOnce();
  });

  test("previews once through the real editor chain despite loading, result, field and parent updates", async () => {
    vi.useFakeTimers();
    let resolve;
    const onPreviewSchedule = vi.fn(() => new Promise((done) => { resolve = done; }));
    const state = fixture();
    const props = {state, onPreviewSchedule};
    const view = render(<AutomationsPanel {...props} />);
    fireEvent.click(screen.getByRole("button", {name: "New automation"}));
    expect(screen.getByText("Checking schedule...")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(onPreviewSchedule).toHaveBeenCalledTimes(1);
    await act(async () => resolve({occurrences: [{local: "current occurrence", timezone: "UTC"}]}));
    expect(screen.queryByText("Checking schedule...")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", {name: /^Name/}), {target: {value: "Edited"}});
    fireEvent.change(screen.getByRole("textbox", {name: /^Instructions/}), {target: {value: "Unrelated"}});
    view.rerender(<AutomationsPanel {...props} state={{...state, automations: {...state.automations, history: {...state.automations.history, runs: []}}}} />);
    await act(() => vi.advanceTimersByTimeAsync(11_000));
    expect(onPreviewSchedule).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/current occurrence/)).toBeInTheDocument();
  });

  test("shows preview failures locally and ignores completion from a closed editor or old workspace", async () => {
    vi.useFakeTimers();
    const requests = [];
    const onPreviewSchedule = vi.fn(() => new Promise((resolve, reject) => requests.push({resolve, reject})));
    const state = fixture();
    const view = render(<AutomationsPanel state={state} onPreviewSchedule={onPreviewSchedule} />);
    fireEvent.click(screen.getByRole("button", {name: "New automation"}));
    await act(() => vi.advanceTimersByTimeAsync(350));
    fireEvent.click(screen.getAllByRole("button", {name: "Cancel"})[0]);
    fireEvent.click(screen.getByRole("button", {name: "New automation"}));
    await act(() => vi.advanceTimersByTimeAsync(350));
    await act(async () => requests[0].resolve({occurrences: [{local: "closed editor"}]}));
    expect(screen.queryByText(/closed editor/)).not.toBeInTheDocument();
    expect(screen.getByText("Checking schedule...")).toBeInTheDocument();
    await act(async () => requests[1].reject(Object.assign(new Error("unavailable"), {code: "schedule_unavailable"})));
    expect(screen.getByText("schedule_unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Checking schedule...")).not.toBeInTheDocument();
    expect(state.automations.error).toBe("");
    fireEvent.change(screen.getByRole("combobox", {name: "Timezone"}), {target: {value: "Europe/London"}});
    await act(() => vi.advanceTimersByTimeAsync(350));
    const nextState = {...state, selectedWorkspaceId: "workspace-2", workspaces: [{id: "workspace-2", name: "Second"}]};
    view.rerender(<AutomationsPanel state={nextState} onPreviewSchedule={onPreviewSchedule} />);
    fireEvent.click(screen.getByRole("button", {name: "New automation"}));
    await act(() => vi.advanceTimersByTimeAsync(350));
    await act(async () => requests[2].resolve({occurrences: [{local: "old workspace"}]}));
    expect(screen.queryByText(/old workspace/)).not.toBeInTheDocument();
    expect(screen.getByText("Checking schedule...")).toBeInTheDocument();
    await act(async () => requests[3].resolve({occurrences: [{local: "new workspace"}]}));
    expect(screen.getByText(/new workspace/)).toBeInTheDocument();
    expect(screen.queryByText("Checking schedule...")).not.toBeInTheDocument();
  });

  test("requires existing shared storage and does not enable run actions before ready", async () => {
    const user = userEvent.setup();
    const state = fixture({automations: {storageState: "legacy", definitions: [{id: "a1", name: "Daily", cron: "0 9 * * *", timezone: "UTC", enabled: false} ]}});
    renderPanel(state);

    expect(screen.getByRole("button", {name: "Shared storage required"})).toBeDisabled();
    expect(screen.getByText(/never creates one/)).toBeInTheDocument();
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
        configured: true,
        errorCode: null,
      },
    };
    renderPanel(state);

    expect(screen.getByRole("heading", {name: "Ready"})).toBeInTheDocument();
    expect(screen.getByText(/Existing backend-owned shared storage is ready/)).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Storage ready"})).toBeDisabled();
    expect(screen.queryByRole("button", {name: "Prepare automations"})).not.toBeInTheDocument();
  });
});
