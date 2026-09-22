import {act, fireEvent, render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, describe, expect, test, vi} from "vitest";
import {AutomationEditor, automationEditorErrors, automationPayload, createAutomationDraft} from "./AutomationEditor.jsx";
import {cronForDaily, cronForWeekly, inferScheduleMode, ScheduleControls} from "./ScheduleControls.jsx";

afterEach(() => {
  vi.useRealTimers();
});

describe("automation editor helpers", () => {
  test("uses the persisted user timezone for new automations and preserves an edited override", () => {
    expect(createAutomationDraft({userTimezone: "America/Chicago"})).toMatchObject({
      allowParallelWithMain: true,
      cron: "0 9 * * *",
      enabled: false,
      timezone: "America/Chicago",
    });
    expect(createAutomationDraft({
      automation: {
        allowParallelWithMain: false,
        cron: "30 14 * * 2",
        enabled: true,
        name: "Weekly report",
        prompt: "Summarize the week.",
        timezone: "Europe/London",
      },
      userTimezone: "America/Chicago",
    })).toMatchObject({
      cron: "30 14 * * 2",
      prompt: "Summarize the week.",
      scheduleMode: "weekly",
      timezone: "Europe/London",
    });
  });

  test("round-trips daily and weekly controls to canonical numeric cron", () => {
    expect(cronForDaily("09:30")).toBe("30 9 * * *");
    expect(cronForWeekly("17:05", "6")).toBe("5 17 * * 6");
    expect(inferScheduleMode("30 9 * * *")).toBe("daily");
    expect(inferScheduleMode("5 17 * * 6")).toBe("weekly");
    expect(inferScheduleMode("0 9 1 * *")).toBe("advanced");
    expect(automationPayload({
      cron: "0 9 1 * *",
      name: "Monthly",
      prompt: "Check the month.",
      timezone: "UTC",
    }).cron).toBe("0 9 1 * *");
  });

  test("defaults recovery safely and requires an acknowledgement for safe retries", () => {
    expect(createAutomationDraft({userTimezone: "UTC"})).toMatchObject({
      catchUpWindowMinutes: 1440,
      maximumRetries: 0,
      missedRunPolicy: "skip",
      replaySafe: false,
      retryPolicy: "none",
    });
    expect(automationEditorErrors({
      catchUpWindowMinutes: 1440,
      cron: "0 9 * * *",
      name: "Daily",
      prompt: "Check files.",
      replaySafe: false,
      retryPolicy: "safe",
      timezone: "UTC",
    }).replaySafe).toMatch(/Acknowledge/);
    expect(automationPayload({
      catchUpWindowMinutes: 60,
      maximumRetries: 2,
      missedRunPolicy: "latest",
      replaySafe: true,
      retryPolicy: "safe",
    })).toMatchObject({catchUpWindowMinutes: 60, maximumRetries: 2, missedRunPolicy: "latest", replaySafe: true, retryPolicy: "safe"});
  });
});

describe("AutomationEditor", () => {
  test("preserves enabled draft intent when readiness is lost and allows an explicit disabled save", async () => {
    const user = userEvent.setup();
    const draft = {cron: "0 9 * * *", name: "Daily", prompt: "Retain these instructions", timezone: "UTC", enabled: true, modelSelection: {modelId: "configured"}};
    const onSave = vi.fn();
    const onChange = vi.fn();
    const view = render(<AutomationEditor draft={draft} onChange={onChange} onSave={onSave} />);
    view.rerender(<AutomationEditor draft={draft} modelConfigured={false} onChange={onChange} onSave={onSave} />);
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toBeChecked();
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toBeEnabled();
    expect(screen.getByRole("button", {name: "Save automation"})).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", {name: "Save automation"}).closest("form"));
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", {name: "Enabled"}));
    expect(onChange).toHaveBeenLastCalledWith({...draft, enabled: false});
    view.rerender(<AutomationEditor draft={{...draft, enabled: false}} modelConfigured={false} onChange={onChange} onSave={onSave} />);
    await user.click(screen.getByRole("button", {name: "Save automation"}));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({enabled: false, prompt: draft.prompt}));
  });

  test("keeps invalid drafts from submitting and exposes field errors", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<AutomationEditor draft={{cron: "not cron", name: "", prompt: "", timezone: "Not/AZone"}} onSave={onSave} />);

    expect(automationEditorErrors({cron: "not cron", name: "", prompt: "", timezone: "Not/AZone"})).toMatchObject({
      cron: expect.any(String),
      name: "Add a name.",
      prompt: "Add instructions for the automation.",
      timezone: expect.any(String),
    });
    await user.click(screen.getByRole("button", {name: "Save automation"}));
    expect(onSave).not.toHaveBeenCalled();
  });

  test("retains the prompt while showing an optimistic-concurrency conflict", () => {
    render(
        <AutomationEditor
          conflict={{expectedRevision: 2}}
          draft={{cron: "0 9 * * *", name: "Daily", prompt: "Keep this exact instruction", timezone: "UTC"}}
          error="Save failed"
        />,
    );

    expect(screen.getByRole("textbox", {name: "Instructions"})).toHaveValue("Keep this exact instruction");
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    expect(screen.getByText(/This automation changed elsewhere/)).toBeInTheDocument();
  });
});

describe("schedule preview", () => {
  test("debounces only schedule/context changes while invoking the latest callbacks", async () => {
    vi.useFakeTimers();
    const original = vi.fn();
    const replacement = vi.fn().mockResolvedValue({occurrences: []});
    const onPreviewStateChange = vi.fn();
    const props = {cron: "0 9 * * *", timezone: "UTC", onPreview: original, onPreviewStateChange, previewContextKey: "one"};
    const view = render(<ScheduleControls {...props} />);
    await act(() => vi.advanceTimersByTimeAsync(200));
    view.rerender(<ScheduleControls {...props} onPreview={replacement} />);
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(original).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(onPreviewStateChange).toHaveBeenLastCalledWith({data: {occurrences: []}, error: "", loading: false});
    view.rerender(<ScheduleControls {...props} onPreview={replacement} cron="1 9 * * *" />);
    await act(() => vi.advanceTimersByTimeAsync(200));
    view.rerender(<ScheduleControls {...props} onPreview={replacement} cron="2 9 * * *" timezone="Europe/London" />);
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(replacement).toHaveBeenCalledTimes(2);
    expect(replacement).toHaveBeenLastCalledWith("2 9 * * *", "Europe/London");
    view.rerender(<ScheduleControls {...props} onPreview={replacement} previewContextKey="two" />);
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(replacement).toHaveBeenCalledTimes(3);
  });

  test("invalid input and cancellation fence stale success, rejection and loading", async () => {
    vi.useFakeTimers();
    const requests = [];
    const onPreview = vi.fn(() => new Promise((resolve, reject) => requests.push({resolve, reject})));
    const onPreviewStateChange = vi.fn();
    const props = {cron: "0 9 * * *", timezone: "UTC", onPreview, onPreviewStateChange};
    const view = render(<ScheduleControls {...props} />);
    await act(() => vi.advanceTimersByTimeAsync(350));
    view.rerender(<ScheduleControls {...props} timezone="invalid" />);
    expect(onPreviewStateChange).toHaveBeenLastCalledWith({data: null, error: expect.stringMatching(/IANA/), loading: false});
    const count = onPreviewStateChange.mock.calls.length;
    await act(async () => requests[0].reject(new Error("stale error")));
    expect(onPreviewStateChange).toHaveBeenCalledTimes(count);
    view.rerender(<ScheduleControls {...props} />);
    await act(() => vi.advanceTimersByTimeAsync(350));
    view.rerender(<ScheduleControls {...props} cron="5 9 * * *" />);
    await act(() => vi.advanceTimersByTimeAsync(350));
    await act(async () => requests[1].resolve({occurrences: [{local: "stale"}]}));
    expect(onPreviewStateChange).toHaveBeenLastCalledWith({data: null, error: "", loading: true});
    await act(async () => requests[2].reject(new Error("current error")));
    expect(onPreviewStateChange).toHaveBeenLastCalledWith({data: null, error: "current error", loading: false});
    view.rerender(<ScheduleControls {...props} cron="6 9 * * *" />);
    await act(() => vi.advanceTimersByTimeAsync(350));
    view.unmount();
    const beforeUnmount = onPreviewStateChange.mock.calls.length;
    await act(async () => requests[3].resolve({occurrences: []}));
    expect(onPreviewStateChange).toHaveBeenCalledTimes(beforeUnmount);
  });

  test("ignores an older debounced preview response after the schedule changes", async () => {
    vi.useFakeTimers();
    const previewResults = [];
    const resolvers = [];
    const onPreview = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    const onPreviewResult = vi.fn((result) => previewResults.push(result));
    const {rerender} = render(
        <ScheduleControls
          cron="0 9 * * *"
          onChange={vi.fn()}
          onPreview={onPreview}
          onPreviewResult={onPreviewResult}
          timezone="America/Chicago"
        />,
    );

    await vi.advanceTimersByTimeAsync(350);
    expect(onPreview).toHaveBeenCalledWith("0 9 * * *", "America/Chicago");
    rerender(
        <ScheduleControls
          cron="30 10 * * *"
          onChange={vi.fn()}
          onPreview={onPreview}
          onPreviewResult={onPreviewResult}
          timezone="America/Chicago"
        />,
    );
    await vi.advanceTimersByTimeAsync(350);
    expect(onPreview).toHaveBeenLastCalledWith("30 10 * * *", "America/Chicago");

    resolvers[0]({occurrences: [{local: "old"}]});
    await vi.advanceTimersByTimeAsync(0);
    expect(previewResults).toEqual([]);
    resolvers[1]({occurrences: [{local: "new"}]});
    await vi.advanceTimersByTimeAsync(0);
    expect(previewResults).toEqual([{occurrences: [{local: "new"}]}]);
  });
});
