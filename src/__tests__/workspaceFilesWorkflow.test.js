import {describe, expect, test, vi} from "vitest";
import {
  createWorkspaceDirectoryState,
  createWorkspaceFileState as createWorkspaceFileEntryState,
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
  test("ignores a file response after the selected session changes", async () => {
    const state = createWorkspaceFileState();
    let resolveRequest;
    state.api.getWorkspaceFiles = vi.fn(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const request = {isCurrent: () => state.selectedSessionId === "session-a"};
    state.selectedSessionId = "session-a";

    const load = loadWorkspaceFilesState(state, "", request);
    state.selectedSessionId = "session-b";
    resolveRequest({
      files: [{path: "from-session-a.md", name: "from-session-a.md", type: "file", size: 1}],
      truncated: false,
    });
    await load;

    expect(state.workspaceFiles).toEqual([]);
  });

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

  test("creates a file in the active directory, refreshes it, and opens the editor", async () => {
    const state = createWorkspaceFileState();
    state.workspaceFileActiveDirectory = "src";
    state.api.createWorkspaceFile = vi.fn(async () => ({file: {path: "src/New.md"}}));
    state.api.syncWorkspaceFiles = vi.fn(async () => ({}));
    state.api.getWorkspaceFile = vi.fn(async () => ({name: "New.md", content: ""}));
    const render = vi.fn();

    await createWorkspaceFileEntryState({
      state,
      path: "New.md",
      loadWorkspaceFiles: (path) => loadWorkspaceFilesState(state, path),
      render,
    });

    expect(state.api.createWorkspaceFile).toHaveBeenCalledWith("workspace-1", "src/New.md");
    expect(state.api.syncWorkspaceFiles).toHaveBeenCalledWith("workspace-1");
    expect(state.api.getWorkspaceFile).toHaveBeenCalledWith("workspace-1", "src/New.md");
    expect(state.fileEditor).toMatchObject({
      content: "",
      open: true,
      path: "src/New.md",
      saving: false,
    });
    expect(state.workspaceFilesUploadMessage).toBe("Created file src/New.md.");
  });

  test("creates a directory and rejects empty or unsafe names", async () => {
    const state = createWorkspaceFileState();
    state.api.createWorkspaceDirectory = vi.fn(async () => ({file: {path: "docs"}}));
    state.api.syncWorkspaceFiles = vi.fn(async () => ({}));
    const render = vi.fn();

    await createWorkspaceDirectoryState({
      state,
      path: "docs",
      loadWorkspaceFiles: (path) => loadWorkspaceFilesState(state, path),
      render,
    });
    expect(state.api.createWorkspaceDirectory).toHaveBeenCalledWith("workspace-1", "docs");

    await createWorkspaceDirectoryState({
      state,
      path: "../secrets",
      loadWorkspaceFiles: (path) => loadWorkspaceFilesState(state, path),
      render,
    });
    expect(state.workspaceFilesError).toBe("Enter a file or directory name.");
    expect(state.api.createWorkspaceDirectory).toHaveBeenCalledTimes(1);
  });
});
