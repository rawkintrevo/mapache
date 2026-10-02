import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {GoogleWorkspaceModal} from "./GoogleWorkspaceModal.jsx";

describe("GoogleWorkspaceModal", () => {
  test("edits services and access before starting the reconnect flow", async () => {
    const user = userEvent.setup();
    const onStartConnection = vi.fn();
    const onUpdateAccessLevel = vi.fn();
    const onUpdatePermanentDelete = vi.fn();
    const onUpdateService = vi.fn();
    render(
        <GoogleWorkspaceModal
          googleWorkspace={{
            accessLevel: "write",
            connecting: false,
            deleting: false,
            editingConnectionId: "connection-a",
            saving: false,
            gmailPermanentDeleteEnabled: false,
            selectedServices: ["gmail"],
            data: {
              connections: [{connectionId: "connection-a", email: "a@example.com"}],
              services: [{
                key: "gmail",
                displayName: "Gmail",
                accessLevels: ["read", "write"],
                optionalPermissions: [{
                  key: "gmailPermanentDeleteEnabled",
                  displayName: "Permanent Gmail deletion",
                  description: "Permanently delete messages or threads, bypassing Trash. This cannot be undone.",
                }],
              }],
            },
          }}
          onClose={vi.fn()}
          onStartConnection={onStartConnection}
          onUpdateAccessLevel={onUpdateAccessLevel}
          onUpdatePermanentDelete={onUpdatePermanentDelete}
          onUpdateService={onUpdateService}
        />,
    );

    expect(screen.getByRole("dialog", {name: "Edit Google account"})).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", {name: "Gmail Google service"}));
    expect(onUpdateService).toHaveBeenCalledWith("gmail", false);
    await user.selectOptions(screen.getByLabelText("Access level"), "write");
    expect(onUpdateAccessLevel).toHaveBeenCalledWith("write");
    await user.click(screen.getByRole("checkbox", {name: "Allow permanent Gmail deletion"}));
    expect(onUpdatePermanentDelete).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", {name: "Start Google authorization"}));
    expect(onStartConnection).toHaveBeenCalledWith({reconnect: true});
  });
});
