import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {SessionModal} from "./SessionModal.jsx";

const workspace = {id: "workspace-1", source: {type: "blank"}};

describe("SessionModal session sizing", () => {
  test("defaults cloud creation to Small without exposing a runner image selector", async () => {
    const user = userEvent.setup();
    const onCreateSession = vi.fn();
    render(<SessionModal busy={false} selectedWorkspace={workspace} onClose={vi.fn()} onCreateSession={onCreateSession} />);

    expect(screen.getByRole("radio", {name: /Small/})).toBeChecked();
    expect(screen.queryByRole("combobox", {name: "Container image"})).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Sized session");
    await user.click(screen.getByRole("button", {name: "Create session"}));

    expect(onCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      cpu: "1",
      memory: "2Gi",
      name: "Sized session",
      sessionType: "cloud",
    }));
    expect(onCreateSession.mock.calls[0][0]).not.toHaveProperty("imageKey");
  });

  test("keeps SSH creation on the existing advanced CPU/memory controls", () => {
    render(<SessionModal busy={false} selectedWorkspace={{id: "workspace-ssh", source: {type: "ssh"}}} onClose={vi.fn()} onCreateSession={vi.fn()} />);

    expect(screen.queryByRole("radiogroup", {name: "Session size presets"})).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", {name: "CPU"})).toHaveValue("1");
    expect(screen.getByRole("combobox", {name: "Memory"})).toHaveValue("1Gi");
  });
});
