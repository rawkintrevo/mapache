import {afterEach, describe, expect, test, vi} from "vitest";
import {createWorkspaceController, normalizeCreateWorkspaceSource} from "../controllers/workspaceController.js";
import {APP_ACTIONS} from "../state/appStore.js";
import {createInitialState} from "../state/initialState.js";

function createFixture(overrides = {}) {
  const state = {
    ...createInitialState(),
    api: {
      getWorkspaces: vi.fn().mockResolvedValue({workspaces: []}),
      createWorkspace: vi.fn().mockResolvedValue({workspace: {id: "workspace-new"}}),
      deleteWorkspace: vi.fn().mockResolvedValue({}),
      renameWorkspace: vi.fn().mockResolvedValue({workspace: {id: "workspace-1", name: "New Docs"}}),
    },
    ...overrides,
  };
  const dispatch = vi.fn((action) => {
    if (action.type === APP_ACTIONS.SET_SELECTED_WORKSPACE) state.selectedWorkspaceId = action.workspaceId;
    if (action.type === APP_ACTIONS.SET_SELECTED_SESSION) state.selectedSessionId = action.sessionId;
    if (action.type === APP_ACTIONS.SET_ACTIVE_PAGE) state.activePage = action.page;
  });
  return {
    state,
    dispatch,
    runBusy: vi.fn(async (task) => task()),
    refreshAll: vi.fn(),
    loadSessions: vi.fn(),
    loadMcpServers: vi.fn(),
    loadSelectedSessionPanels: vi.fn(),
    resetWorkspacePanels: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspaceController", () => {
  test("repairs a removed selection and resets workspace-scoped panels", async () => {
    const fixture = createFixture({
      workspaces: [{id: "workspace-old"}],
      selectedWorkspaceId: "workspace-old",
    });
    fixture.state.api.getWorkspaces.mockResolvedValue({workspaces: [{id: "workspace-new"}]});
    const controller = createWorkspaceController(fixture);

    await controller.refreshWorkspaceList();

    expect(fixture.state.selectedWorkspaceId).toBe("workspace-new");
    expect(fixture.dispatch).toHaveBeenCalledWith({
      type: APP_ACTIONS.SET_SELECTED_WORKSPACE,
      workspaceId: "workspace-new",
    });
    expect(fixture.resetWorkspacePanels).toHaveBeenCalledTimes(1);
  });

  test("creates a workspace with the normalized source and refreshes selection", async () => {
    const fixture = createFixture();
    const controller = createWorkspaceController(fixture);

    await controller.createWorkspace({
      name: "Docs",
      source: {type: "github", repoUrl: "https://github.com/example/docs"},
      branch: "main",
      env: {MODE: "test"},
    });

    expect(fixture.state.api.createWorkspace).toHaveBeenCalledWith({
      name: "Docs",
      source: {
        type: "github",
        repoUrl: "https://github.com/example/docs",
        requestedBranch: "main",
      },
      env: {MODE: "test"},
    });
    expect(fixture.state.selectedWorkspaceId).toBe("workspace-new");
    expect(fixture.state.selectedSessionId).toBeNull();
    expect(fixture.resetWorkspacePanels).toHaveBeenCalledTimes(1);
    expect(fixture.refreshAll).toHaveBeenCalledTimes(1);
  });

  test("selection resets panels before loading sessions and workspace panels", async () => {
    const fixture = createFixture();
    const controller = createWorkspaceController(fixture);

    await controller.selectWorkspace("workspace-2");

    expect(fixture.state.selectedWorkspaceId).toBe("workspace-2");
    expect(fixture.state.activePage).toBe("workspace");
    expect(fixture.resetWorkspacePanels).toHaveBeenCalledWith();
    expect(fixture.loadSessions).toHaveBeenCalledTimes(1);
    expect(fixture.loadMcpServers).toHaveBeenCalledTimes(1);
    expect(fixture.loadSelectedSessionPanels).toHaveBeenCalledTimes(1);
  });

  test("keeps delete confirmation and clears a deleted selection", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fixture = createFixture({
      workspaces: [{id: "workspace-1", name: "Docs"}],
      selectedWorkspaceId: "workspace-1",
    });
    const controller = createWorkspaceController(fixture);

    await controller.deleteWorkspace("workspace-1");

    expect(window.confirm).toHaveBeenCalledWith(
      "Delete workspace Docs? Sessions will be stopped and workspace files will be removed.",
    );
    expect(fixture.state.api.deleteWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(fixture.state.selectedWorkspaceId).toBeNull();
    expect(fixture.state.selectedSessionId).toBeNull();
    expect(fixture.resetWorkspacePanels).toHaveBeenCalledWith({includeMcp: false});
    expect(fixture.refreshAll).toHaveBeenCalledTimes(1);
  });

  test("renames a workspace and refreshes the workspace list", async () => {
    const fixture = createFixture({
      workspaces: [{id: "workspace-1", name: "Docs"}],
      selectedWorkspaceId: "workspace-1",
    });
    fixture.state.api.getWorkspaces.mockResolvedValue({
      workspaces: [{id: "workspace-1", name: "New Docs"}],
    });
    const controller = createWorkspaceController(fixture);

    const saved = await controller.renameWorkspace("workspace-1", "  New Docs  ");

    expect(saved).toBe(true);
    expect(fixture.state.api.renameWorkspace).toHaveBeenCalledWith("workspace-1", "New Docs");
    expect(fixture.state.api.getWorkspaces).toHaveBeenCalledTimes(1);
    expect(fixture.state.workspaces[0].name).toBe("New Docs");
  });
});

describe("normalizeCreateWorkspaceSource", () => {
  test("normalizes blank, SSH, and GitHub sources", () => {
    expect(normalizeCreateWorkspaceSource()).toEqual({type: "blank"});
    expect(normalizeCreateWorkspaceSource({source: "ssh"})).toEqual({type: "ssh"});
    expect(normalizeCreateWorkspaceSource({
      source: {type: "github", repoUrl: "https://github.com/example/docs"},
      branch: "main",
    })).toEqual({
      type: "github",
      repoUrl: "https://github.com/example/docs",
      requestedBranch: "main",
    });
  });
});
