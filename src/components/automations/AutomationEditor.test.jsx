import {render, screen} from "@testing-library/react";
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
