import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {PiAuthManageModal} from "./PiAuthManageModal.jsx";

function renderModal(overrides = {}) {
  const props = {
    piAuth: {
      loading: false,
      saving: false,
      error: "",
      entries: {
        "anthropic-main": {
          credential: {type: "api_key"},
          label: "Main Anthropic",
          providerKey: "anthropic",
        },
        "anthropic-backup": {
          credential: {type: "api_key"},
          label: "Backup Anthropic",
          providerKey: "anthropic",
        },
      },
      environmentEntries: [{id: "env-1", label: "Old environment key", name: "OLD_KEY"}],
      providers: {},
    },
    session: {
      id: "session-1",
      terminalKind: "pi",
      authSelection: {providers: {anthropic: "anthropic-main"}},
      environmentEntryIds: ["env-1"],
    },
    onAdd: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onOpenModelsFile: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
  render(<PiAuthManageModal {...props} />);
  return props;
}

describe("PiAuthManageModal", () => {
  test("lists saved credentials with checkbox, edit, delete, and add controls", async () => {
    const user = userEvent.setup();
    const props = renderModal();

    expect(screen.getByRole("button", {name: "Add authentication provider"})).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Inspect/edit models.json"}));
    expect(props.onOpenModelsFile).toHaveBeenCalled();
    expect(screen.getByRole("checkbox", {name: /Main Anthropic/})).toBeChecked();
    expect(screen.getByRole("checkbox", {name: /Backup Anthropic/})).not.toBeChecked();
    expect(screen.queryByText("Old environment key")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", {name: "Edit Main Anthropic"}));
    expect(props.onEdit).toHaveBeenCalledWith(expect.objectContaining({providerKey: "anthropic"}));
    await user.click(screen.getByRole("button", {name: "Delete Main Anthropic"}));
    expect(props.onDelete).toHaveBeenCalledWith("anthropic-main");
  });

  test("checking a sibling credential replaces the provider selection without changing environment keys", async () => {
    const user = userEvent.setup();
    const props = renderModal();

    await user.click(screen.getByRole("checkbox", {name: /Backup Anthropic/}));
    await user.click(screen.getByRole("button", {name: "Save"}));

    expect(props.onSave).toHaveBeenCalledWith({harness: "pi", providers: {anthropic: "anthropic-backup"}});
  });
});
