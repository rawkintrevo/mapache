import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {InstancesPage, formatElapsed} from "./InstancesPage.jsx";
import {createInitialState} from "../../state/initialState.js";

function createState() {
  return {
    ...createInitialState(),
    workspaces: [{id: "workspace-1", name: "Writing"}],
    instances: {
      ...createInitialState().instances,
      instances: [{
        heartbeatAt: "2026-09-20T12:04:00.000Z",
        id: "run-1",
        resources: {cpu: "2", memory: "4Gi"},
        runId: "run-1",
        startedAt: "2026-09-20T12:00:00.000Z",
        status: "running",
        stopTarget: {runId: "run-1", type: "automation-run", workspaceId: "workspace-1"},
        type: "automation",
        workspaceId: "workspace-1",
      }],
    },
  };
}

test("renders owner-wide inventory links and delegates the selected stop target", async () => {
  const user = userEvent.setup();
  const onStopInstance = vi.fn();
  const onShowHistory = vi.fn();
  render(
    <InstancesPage
      onLoadNextPage={vi.fn()}
      onSelectWorkspace={vi.fn()}
      onSetFilters={vi.fn()}
      onShowHistory={onShowHistory}
      onStopInstance={onStopInstance}
      state={createState()}
    />,
  );

  expect(screen.getByRole("heading", {name: /Running instances/})).toBeInTheDocument();
  expect(screen.getByRole("cell", {name: "Writing View run history"})).toBeInTheDocument();
  expect(screen.getByText("2 / 4Gi")).toBeInTheDocument();
  await user.click(screen.getByRole("button", {name: "View run history"}));
  await user.click(screen.getByRole("button", {name: "Stop"}));
  expect(onShowHistory).toHaveBeenCalledWith("run-1");
  expect(onStopInstance).toHaveBeenCalledWith(expect.objectContaining({runId: "run-1"}));
});

test("formats elapsed runtime compactly", () => {
  expect(formatElapsed("2026-09-20T11:00:00.000Z", Date.parse("2026-09-20T12:05:00.000Z"))).toBe("1h 5m");
  expect(formatElapsed("not-a-date", Date.now())).toBe("—");
});
