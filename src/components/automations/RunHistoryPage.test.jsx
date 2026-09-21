import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {RunHistoryPage} from "./RunHistoryPage.jsx";
import {createInitialState} from "../../state/initialState.js";

function createState(overrides = {}) {
  return {
    ...createInitialState(),
    workspaces: [{id: "workspace-1", name: "Writing"}, {id: "workspace-2", name: "Research"}],
    automations: {
      ...createInitialState().automations,
      globalHistory: {
        ...createInitialState().automations.globalHistory,
        runs: [{
          automationId: "automation-1",
          automationName: "Daily digest",
          createdAt: "2026-09-20T10:00:00.000Z",
          id: "run-1",
          status: "succeeded",
          workspaceId: "workspace-1",
        }],
      },
      ...overrides,
    },
  };
}

const handlers = () => ({
  onLoadEvents: vi.fn(),
  onLoadHistory: vi.fn(),
  onLoadNextPage: vi.fn(),
  onRestartRun: vi.fn(),
  onSelectRun: vi.fn(),
  onSetFilters: vi.fn(),
  onStopRun: vi.fn(),
});

describe("RunHistoryPage", () => {
  test("loads global history, filters across workspaces, and keeps pagination controls accessible", async () => {
    const user = userEvent.setup();
    const props = handlers();
    render(<RunHistoryPage {...props} state={createState()} />);

    expect(props.onLoadHistory).toHaveBeenCalledOnce();
    expect(screen.getByRole("cell", {name: "Writing"})).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", {name: "Workspace"}), "workspace-2");
    await user.click(screen.getByRole("button", {name: "Apply filters"}));
    expect(props.onSetFilters).toHaveBeenCalledWith({workspaceId: "workspace-2"});
  });

  test("renders an archived run detail with safe markdown and guards terminal actions", async () => {
    const user = userEvent.setup();
    const props = handlers();
    const state = createState({
      selectedRunId: "run-1",
      selectedRunScope: "global",
      selectedRun: {
        actions: {canRestart: true, canStop: false},
        archiveAvailable: true,
        createdAt: "2026-09-20T10:00:00.000Z",
        finalResult: {answer: "done"},
        id: "run-1",
        snapshot: {
          allowParallelWithMain: true,
          cron: "0 9 * * *",
          prompt: "# Archived instructions\n\n<script>alert('xss')</script>",
          timezone: "America/Chicago",
        },
        status: "succeeded",
        workspaceId: "workspace-1",
      },
      events: [{kind: "transcript", record: "**Archived response**"}],
      eventsNextCursor: "next-events",
    });
    render(<RunHistoryPage {...props} state={state} />);

    expect(screen.getByRole("heading", {name: "Archived instructions"})).toBeInTheDocument();
    expect(screen.queryByRole("script")).not.toBeInTheDocument();
    expect(screen.queryByText("Partial archive", {exact: false})).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Restart"}));
    await user.click(screen.getByRole("button", {name: "Load more"}));
    expect(props.onRestartRun).toHaveBeenCalledWith("run-1");
    expect(props.onLoadEvents).toHaveBeenCalledWith("run-1", {append: true});
  });

  test("shows a partial-archive label and queued Stop action", async () => {
    const user = userEvent.setup();
    const props = handlers();
    const state = createState({
      selectedRunId: "run-1",
      selectedRunScope: "global",
      selectedRun: {archiveAvailable: false, id: "run-1", persistenceState: "partial", status: "queued"},
    });
    render(<RunHistoryPage {...props} state={state} />);

    expect(screen.getByText("Partial archive", {exact: false})).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Stop"}));
    expect(props.onStopRun).toHaveBeenCalledWith("run-1");
  });
});
