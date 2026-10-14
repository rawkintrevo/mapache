import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {WorkspaceUploadModal} from "./WorkspaceUploadModal.jsx";
import {uploadWorkspaceFile} from "../../services/workspaceUploads.js";
vi.mock("../../services/workspaceUploads.js", () => ({MAX_UPLOAD_BYTES: 1024 ** 3, uploadWorkspaceFile: vi.fn(), cancelWorkspaceUpload: vi.fn()}));
describe("workspace upload dialog", () => {
  it("uploads to the selected workspace and shows the resulting path", async () => {
    uploadWorkspaceFile.mockResolvedValue({path: "/uploads/local.csv"});
    const api = {createWorkspaceUpload: vi.fn().mockResolvedValue({uploadUrl: "private", path: "/uploads/local.csv"})};
    render(<WorkspaceUploadModal workspace={{id: "w", name: "Research"}} api={api} onClose={() => {}} />);
    const file = new File(["a,b"], "local.csv");
    fireEvent.change(screen.getByLabelText("Choose a file"), {target: {files: [file]}});
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Uploaded to /uploads/local.csv"));
    expect(api.createWorkspaceUpload).toHaveBeenCalledWith("w", file);
  });
  it("rejects oversized files without requesting an upload", async () => {
    const api = {createWorkspaceUpload: vi.fn()};
    render(<WorkspaceUploadModal workspace={{id: "w", name: "Research"}} api={api} onClose={() => {}} />);
    const file = new File(["x"], "large.csv");
    Object.defineProperty(file, "size", {value: 1024 ** 3 + 1});
    fireEvent.change(screen.getByLabelText("Choose a file"), {target: {files: [file]}});
    expect(screen.getByRole("alert")).toHaveTextContent("1 GiB");
    expect(api.createWorkspaceUpload).not.toHaveBeenCalled();
  });
});
