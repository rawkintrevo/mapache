import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {SessionEditModal} from "./SessionEditModal.jsx";

describe("SessionEditModal", () => {
  test("renames a session and submits its selected size", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(
        <SessionEditModal
          busy={false}
          session={{id: "session-1", name: "Old name", resources: {cpu: "1", memory: "2Gi"}}}
          onClose={onClose}
          onSave={onSave}
        />,
    );

    await user.clear(screen.getByRole("textbox", {name: "Name"}));
    await user.type(screen.getByRole("textbox", {name: "Name"}), "New name");
    await user.click(screen.getByRole("radio", {name: /Medium/}));
    await user.click(screen.getByRole("button", {name: "Save changes"}));

    expect(onSave).toHaveBeenCalledWith("session-1", {
      name: "New name",
      resources: {cpu: "2", memory: "4Gi"},
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("keeps the dialog open when saving fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
        <SessionEditModal
          busy={false}
          error="Unable to save"
          session={{id: "session-1", name: "Session", resources: {cpu: "1", memory: "1Gi"}}}
          onClose={onClose}
          onSave={vi.fn().mockResolvedValue(false)}
        />,
    );

    expect(screen.getByText("Unable to save")).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Save changes"}));
    expect(onClose).not.toHaveBeenCalled();
  });
});
