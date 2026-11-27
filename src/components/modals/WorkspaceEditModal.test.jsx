import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {expect, test, vi} from "vitest";
import {WorkspaceEditModal} from "./WorkspaceEditModal.jsx";

test("stages remote resources with an explicit restart instruction", async () => {
  const user = userEvent.setup();
  const save = vi.fn().mockResolvedValue(true);
  const saveMachine = vi.fn();
  render(<WorkspaceEditModal workspace={{id: "remote", name: "Guest", source: {type: "remote-libvirt"},
    resources: {cpu: "3", memory: "4Gi"}}} onSave={save} onClose={vi.fn()} onSaveMachineConfiguration={saveMachine} />);
  expect(screen.getByLabelText("Virtual CPUs")).toHaveValue(3);
  expect(screen.getByText(/Stop a running guest first/)).toBeVisible();
  expect(screen.queryByText(/estimated|per hour/i)).toBeNull();
  await user.clear(screen.getByLabelText("Memory (GiB)"));
  await user.type(screen.getByLabelText("Memory (GiB)"), "6");
  await user.click(screen.getByRole("button", {name: "Save changes"}));
  expect(save).toHaveBeenCalledWith("remote", {name: "Guest", resources: {cpu: "3", memory: "6Gi"}});
  expect(saveMachine).not.toHaveBeenCalled();
});
