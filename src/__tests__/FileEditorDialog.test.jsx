import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {FileEditorDialog} from "../components/modals/FileEditorDialog.jsx";
import {createFileEditorState} from "../state/initialState.js";

function renderEditor(overrides = {}) {
  const props = {
    editor: createFileEditorState({
      open: true,
      path: "README.md",
      name: "README.md",
      content: "# Project\n\n- [x] Preview markdown",
      ...overrides,
    }),
    onClose: vi.fn(),
    onSave: vi.fn(),
    onUpdateContent: vi.fn(),
  };
  render(<FileEditorDialog {...props} />);
  return props;
}

describe("FileEditorDialog", () => {
  test("offers Edit and Preview tabs for Markdown files", async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(screen.getByRole("tab", {name: "Edit"})).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox")).toHaveValue("# Project\n\n- [x] Preview markdown");

    await user.click(screen.getByRole("tab", {name: "Preview"}));

    expect(screen.getByRole("tab", {name: "Preview"})).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", {name: "Project"})).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  test("previews unsaved edits and keeps Save available", async () => {
    const user = userEvent.setup();
    const props = renderEditor();

    const editor = screen.getByRole("textbox");
    await user.clear(editor);
    await user.type(editor, "## Draft preview");
    await user.click(screen.getByRole("tab", {name: "Preview"}));

    expect(screen.getByRole("heading", {name: "Draft preview"})).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Save"}));
    expect(props.onSave).toHaveBeenCalledWith("## Draft preview");
  });

  test("keeps non-Markdown files in edit-only mode", () => {
    renderEditor({path: "src/main.js", name: "main.js", content: "const ready = true;"});

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("const ready = true;");
  });
});
