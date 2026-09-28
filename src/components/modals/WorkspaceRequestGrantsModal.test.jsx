import {fireEvent, render, screen} from "@testing-library/react";
import {describe, expect, test, vi} from "vitest";
import {WorkspaceRequestGrantsModal} from "./WorkspaceRequestGrantsModal.jsx";

const workspaces = [{id: "source", name: "Source"}, {id: "target", name: "Customer Research"}];

function renderModal(overrides = {}) {
  const props = {
    grants: {loading: false, saving: false, error: "", message: "", grants: [], targetWorkspaceId: "", permissions: []},
    onClose: vi.fn(), onLoad: vi.fn(), onRevoke: vi.fn(), onSave: vi.fn(), onSetForm: vi.fn(), onTogglePermission: vi.fn(),
    selectedWorkspace: workspaces[0], workspaces, ...overrides,
  };
  return {props, ...render(<WorkspaceRequestGrantsModal {...props} />)};
}

describe("WorkspaceRequestGrantsModal", () => {
  test("selects a sibling target and independent permissions", () => {
    const {props} = renderModal({grants: {loading: false, saving: false, error: "", message: "", grants: [], targetWorkspaceId: "target", permissions: ["discover"]}});
    expect(screen.getByRole("heading", {name: "Workspace request access"})).toBeInTheDocument();
    expect(screen.getByRole("option", {name: "Customer Research"})).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Submit requests"));
    expect(props.onTogglePermission).toHaveBeenCalledWith("submit");
    fireEvent.click(screen.getByRole("button", {name: "Save grant"}));
    expect(props.onSave).toHaveBeenCalledOnce();
  });

  test("shows current grants and revokes a target", () => {
    const onRevoke = vi.fn();
    renderModal({onRevoke, grants: {loading: false, saving: false, error: "", message: "", grants: [{id: "grant", targetWorkspaceId: "target", permissions: ["discover", "read"]}], targetWorkspaceId: "", permissions: []}});
    fireEvent.click(screen.getByRole("button", {name: "Revoke"}));
    expect(onRevoke).toHaveBeenCalledWith("target");
  });
});
