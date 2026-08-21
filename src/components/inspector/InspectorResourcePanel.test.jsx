import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {InspectorResourcePanel, InspectorResourceRow} from "./InspectorResourcePanel.jsx";

function renderResource(overrides = {}) {
  const props = {
    create: {label: "New widget", onClick: vi.fn()},
    refresh: {onClick: vi.fn()},
    state: {collapsedDrawerSections: new Set()},
    status: {},
    title: "Widgets",
    onToggleDrawerSection: vi.fn(),
    ...overrides,
  };
  render(
    <InspectorResourcePanel {...props}>
      <InspectorResourceRow
        detail={<span>Widget detail</span>}
        edit={{onClick: props.onEdit}}
        resource={{id: "widget-a", name: "Widget A"}}
        onDelete={{onClick: props.onDelete}}
      />
    </InspectorResourcePanel>,
  );
  return props;
}

describe("InspectorResourcePanel", () => {
  test("uses the shared create, refresh, edit, and delete actions", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const props = renderResource({onEdit, onDelete});

    await user.click(screen.getByRole("button", {name: "New widget"}));
    await user.click(screen.getByRole("button", {name: "Refresh"}));
    await user.click(screen.getByRole("button", {name: "Edit Widget A"}));
    await user.click(screen.getByRole("button", {name: "Delete Widget A"}));

    expect(props.create.onClick).toHaveBeenCalledOnce();
    expect(props.refresh.onClick).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledWith({id: "widget-a", name: "Widget A"});
    expect(onDelete).toHaveBeenCalledWith({id: "widget-a", name: "Widget A"});
  });

  test("renders the shared status messages and disables actions while busy", () => {
    const props = renderResource({status: {loading: true, error: "Could not load widgets.", message: "Loading widgets..."}});

    expect(screen.getByText("Could not load widgets.")).toBeTruthy();
    expect(screen.getByText("Loading widgets...")).toBeTruthy();
    expect(screen.getByRole("button", {name: "New widget"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "Refresh"})).toBeDisabled();
    expect(props.create.onClick).not.toHaveBeenCalled();
  });
});
