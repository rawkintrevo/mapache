import {describe, expect, test, vi} from "vitest";
import {
  loadWorkspaceFilesState,
  toggleWorkspaceFileDirState,
} from "../workflows/workspaceFiles.js";
import {createInitialState} from "../state/initialState.js";

function createWorkspaceFileState() {
  const state = createInitialState();
  state.selectedWorkspaceId = "workspace-1";
  state.api = {
    getWorkspaceFiles: vi.fn(async (_workspaceId, path = "") => {
      if (path === "src") {
        return {
          files: [
            {path: "src/App.jsx", name: "App.jsx", type: "file", size: 10},
            {path: "src/components", name: "components", type: "directory", size: 0},
          ],
          truncated: false,
        };
      }
      return {
        files: [
          {path: "README.md", name: "README.md", type: "file", size: 20},
          {path: "src", name: "src", type: "directory", size: 0},
        ],
        truncated: false,
      };
    }),
  };
  return state;
}

describe("workspace file workflow", () => {
  test("loads root files first and fetches directory children on expansion", async () => {
    const state = createWorkspaceFileState();
    await loadWorkspaceFilesState(state);

    expect(state.api.getWorkspaceFiles).toHaveBeenCalledWith("workspace-1", "");
    expect(state.workspaceFiles.map((file) => file.path).sort()).toEqual(["README.md", "src"]);
    expect(state.workspaceFileLoadedDirs.has("")).toBe(true);
    expect(state.workspaceFileLoadedDirs.has("src")).toBe(false);

    await toggleWorkspaceFileDirState({
      state,
      path: "src",
      loadWorkspaceFiles: (path) => loadWorkspaceFilesState(state, path),
      render: vi.fn(),
    });

    expect(state.api.getWorkspaceFiles).toHaveBeenLastCalledWith("workspace-1", "src");
    expect(state.workspaceFiles.map((file) => file.path).sort()).toEqual([
      "README.md",
      "src",
      "src/App.jsx",
      "src/components",
    ]);
    expect(state.workspaceFileLoadedDirs.has("src")).toBe(true);
  });
});
