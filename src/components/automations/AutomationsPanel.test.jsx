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
  test("creates an enabled automation using the editor picker with no workspace model or active session", async () => {
    const user = userEvent.setup();
    const onCreateDefinition = vi.fn().mockResolvedValue({id: "new"});
    const onShowWorkspace = vi.fn();
    renderPanel(fixture(), {onCreateDefinition, onShowWorkspace});
    await user.click(screen.getByRole("button", {name: "New automation"}));
    await user.type(screen.getByRole("textbox", {name: /^Name/}), "Daily report");
    await user.type(screen.getByRole("textbox", {name: /^Instructions/}), "Summarize my files.");
    await user.selectOptions(screen.getByRole("combobox", {name: "Provider"}), "openai");
    await user.selectOptions(screen.getByRole("combobox", {name: "Model"}), "gpt-4.1");
    await user.click(screen.getByRole("checkbox", {name: "Enabled"}));
    await user.click(screen.getByRole("button", {name: "Create automation"}));
    expect(onCreateDefinition).toHaveBeenCalledWith(expect.objectContaining({enabled: true, modelSelection: {providerId: "openai", modelId: "gpt-4.1"}}), "workspace-1");
    expect(onShowWorkspace).not.toHaveBeenCalled();
  });

  test("enables a ready definition and leaves Disable available when storage is lost", async () => {
    const user = userEvent.setup();
    const definition = {id: "a1", name: "Daily", cron: "0 9 * * *", timezone: "UTC", enabled: false, modelSelection: {providerId: "openai", modelId: "configured"}};
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

  test("enables list and editor without prepared storage, preserving drafts through workspace refresh", async () => {
    const user = userEvent.setup();
    const state = fixture({automations: {definitions: [{id: "a1", name: "Daily", cron: "0 9 * * *", timezone: "UTC", enabled: false}]}});
    state.workspaces[0].modelSelection = {providerId: "openai", modelId: "configured"};
    const props = {state};
    const view = render(<AutomationsPanel {...props} />);
    expect(screen.getByRole("button", {name: "Enable"})).toBeEnabled();
    expect(screen.getByRole("button", {name: "Run now"})).toBeEnabled();
    expect(screen.queryByRole("button", {name: /shared storage/i})).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "New automation"}));
    await user.type(screen.getByRole("textbox", {name: /^Name/}), "Retain my draft");
    state.workspaces[0].sharedStorage = {configured: false, state: "error", errorCode: "bucket_missing"};
    view.rerender(<AutomationsPanel {...props} />);
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toBeEnabled();
    expect(screen.getByRole("textbox", {name: /^Name/})).toHaveValue("Retain my draft");
  });

  test("opens the model picker from missing-model guidance without starting the workspace", async () => {
    const user = userEvent.setup();
    const state = fixture({automations: {error: "missing_model_selection", definitions: [{id: "a1", name: "Daily"}]}});
    state.workspaces[0].sharedStorage = {configured: true, state: "ready", errorCode: null};
    const onShowWorkspace = vi.fn();
    renderPanel(state, {onShowWorkspace});
    expect(screen.getByRole("button", {name: "Enable"})).toHaveAccessibleDescription(/automation's editor/);
    expect(screen.queryByText(/changed elsewhere/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Choose model"}));
    expect(screen.getByRole("combobox", {name: "Provider"})).toBeInTheDocument();
    expect(onShowWorkspace).not.toHaveBeenCalled();
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

  test("supports concurrent main sessions with existing GCS and no storage setup action", async () => {
    const user = userEvent.setup();
    const state = fixture({automations: {definitions: [{id: "a1", name: "Daily", modelSelection: {providerId: "openai", modelId: "configured"}}]}});
    state.workspaces[0].modelSelection = {providerId: "openai", modelId: "configured"};
    state.sessions[0].status = "running";
    const onRunNow = vi.fn();
    renderPanel(state, {onRunNow});
    expect(screen.getByText(/main session can keep running/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Run now"}));
    expect(onRunNow).toHaveBeenCalledWith("a1", {trigger: "manual"}, "workspace-1");
    await user.click(screen.getByRole("button", {name: "New automation"}));
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toBeEnabled();
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

  test("describes separate outputs without offering storage provisioning", () => {
    renderPanel(fixture());
    expect(screen.getByRole("heading", {name: "Read-only workspace, separate outputs"})).toBeInTheDocument();
    expect(screen.queryByText(/operator|provision|Shared storage required/)).not.toBeInTheDocument();
  });
});
