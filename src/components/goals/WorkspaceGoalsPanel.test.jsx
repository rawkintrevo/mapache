import {render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {WorkspaceGoalsPanel} from "./WorkspaceGoalsPanel.jsx";

const sessions = [{
  id: "pi-session-1",
  name: "Pi development",
  harnessId: "pi",
  status: "running",
  serviceUrl: "https://runner.example",
  shutdownToken: "token",
}];

function goal(overrides = {}) {
  return {
    id: "goal-1",
    title: "Ship the feature",
    objective: "Build the feature and verify it.",
    lifecycle: "draft",
    mode: "regular",
    revision: 0,
    taskCounts: {completed: 0, total: 0},
    ...overrides,
  };
}

describe("WorkspaceGoalsPanel", () => {
  test("loads saved goals and starts a draft on the selected Pi session", async () => {
    const user = userEvent.setup();
    const api = {
      listGoals: vi.fn().mockResolvedValue({goals: [goal()]}),
      actionGoal: vi.fn().mockResolvedValue({goal: goal({lifecycle: "open", assignedSessionId: "pi-session-1"})}),
    };
    render(<WorkspaceGoalsPanel api={api} sessions={sessions} workspaceId="workspace-1" />);

    expect(await screen.findByText("Ship the feature")).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Start"}));

    await waitFor(() => expect(api.actionGoal).toHaveBeenCalledWith(
        "workspace-1",
        "goal-1",
        expect.objectContaining({action: "start", sessionId: "pi-session-1", expectedRevision: 0}),
    ));
  });

  test("saves a new goal without starting it", async () => {
    const user = userEvent.setup();
    const newGoal = goal({id: "goal-2", title: "New objective", objective: "Do the new work."});
    const api = {
      listGoals: vi.fn().mockResolvedValue({goals: []}),
      createGoal: vi.fn().mockResolvedValue(newGoal),
    };
    render(<WorkspaceGoalsPanel api={api} sessions={sessions} workspaceId="workspace-1" />);

    await user.click(await screen.findByRole("button", {name: "New goal"}));
    await user.type(screen.getByLabelText("Title (optional)"), "New objective");
    await user.type(screen.getByLabelText("Objective"), "Do the new work.");
    await user.click(screen.getByRole("button", {name: "Save goal"}));

    await waitFor(() => expect(api.createGoal).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      title: "New objective",
      objective: "Do the new work.",
      mode: "regular",
      auditEnabled: true,
    })));
    expect(await screen.findByText("New objective")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Goal saved");
  });

  test("shows a pending Pi question and sends the selected answer", async () => {
    const user = userEvent.setup();
    const api = {
      listGoals: vi.fn().mockResolvedValue({goals: [goal({lifecycle: "open", assignedSessionId: "pi-session-1", revision: 2})]}),
      getGoalRuntime: vi.fn().mockResolvedValue({pendingUiRequests: [{id: "question-1", method: "select", title: "Choose a format", options: ["CSV", "JSON"]}]}),
      answerGoalQuestion: vi.fn().mockResolvedValue({ok: true}),
    };
    render(<WorkspaceGoalsPanel api={api} sessions={sessions} workspaceId="workspace-1" />);

    expect(await screen.findByText("Pi needs your input")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", {name: "Choose a format"}), "JSON");
    await user.click(screen.getByRole("button", {name: "Send answer"}));
    await waitFor(() => expect(api.answerGoalQuestion).toHaveBeenCalledWith(
        "workspace-1",
        "goal-1",
        "question-1",
        {requestId: "question-1", answer: "JSON", expectedRevision: 2},
    ));
  });
});

test("keeps Start errors visible after refresh and requests consent before stopping Terminal", async () => {
  const user = userEvent.setup();
  const api = {
    listGoals: vi.fn().mockResolvedValue({goals: [goal({assignedSessionId: null})]}),
    actionGoal: vi.fn().mockRejectedValueOnce(new Error("goal_terminal_process_active")).mockResolvedValueOnce({goal: goal({lifecycle: "open", assignedSessionId: "pi-session-1"})}),
  };
  render(<WorkspaceGoalsPanel api={api} sessions={sessions.map(({shutdownToken, ...session}) => session)} workspaceId="workspace-1" initialSessionId="pi-session-1" />);
  await screen.findByText("Ship the feature");
  expect(screen.getByRole("combobox", {name: "Pi session for goal"})).toHaveValue("pi-session-1");
  await user.click(screen.getByRole("button", {name: "Start"}));
  await waitFor(() => expect(api.listGoals).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("alert")).toHaveTextContent("Pi is open in Terminal/Chat");
  expect(api.actionGoal).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", {name: "Stop Terminal/Chat and start goal"}));
  await waitFor(() => expect(api.actionGoal).toHaveBeenLastCalledWith("workspace-1", "goal-1", expect.objectContaining({sessionId: "pi-session-1", takeOverTerminal: true})));
  expect(await screen.findByRole("button", {name: "Pause"})).toBeInTheDocument();
});

test("reads real nested runtime dialogs and uses the new revision for the second answer", async () => {
  const user = userEvent.setup();
  const running = goal({lifecycle: "open", assignedSessionId: "pi-session-1", revision: 2});
  const questions = ["Choose format", "Choose filename"];
  let revision = 2;
  const api = {
    listGoals: vi.fn().mockResolvedValue({goals: [running]}),
    getGoalRuntime: vi.fn().mockImplementation(async () => ({ok: true, goals: [], runtime: {status: "waiting_for_input", pendingUiRequests: revision < 4 ? [{id: `q-${revision}`, method: "input", title: questions[revision - 2]}] : []}})),
    answerGoalQuestion: vi.fn().mockImplementation(async () => ({ok: true, goal: {...running, revision: ++revision}})),
  };
  render(<WorkspaceGoalsPanel api={api} sessions={sessions} workspaceId="workspace-1" />);
  await user.type(await screen.findByRole("textbox", {name: "Choose format"}), "CSV");
  await user.click(screen.getByRole("button", {name: "Send answer"}));
  await user.type(await screen.findByRole("textbox", {name: "Choose filename"}), "export.csv");
  await user.click(screen.getByRole("button", {name: "Send answer"}));
  await waitFor(() => expect(api.answerGoalQuestion).toHaveBeenLastCalledWith("workspace-1", "goal-1", "q-3", expect.objectContaining({expectedRevision: 3, answer: "export.csv"})));
});
