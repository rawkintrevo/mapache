import {APP_ACTIONS} from "../state/appStore.js";
import {friendlyWorkspaceError} from "../utils/friendlyErrors.js";

export function normalizeCreateWorkspaceSource(payload = {}) {
  const source = payload.source && typeof payload.source === "object" ? payload.source : {};
  const sourceType = String(source.type || payload.source || "blank").trim().toLowerCase();
  if (sourceType !== "github") {
    if (sourceType === "ssh") {
      return {...source, type: "ssh"};
    }
    return {type: "blank"};
  }

  return {
    ...source,
    type: "github",
    repoUrl: source.repoUrl || payload.repoUrl || "",
    requestedBranch: source.requestedBranch || payload.branch || "",
  };
}

export function createWorkspaceController({
  state,
  dispatch,
  runBusy,
  refreshAll,
  loadSessions,
  loadMcpServers,
  loadSelectedSessionPanels,
  resetWorkspacePanels,
}) {
  async function refreshWorkspaceList() {
    const data = await state.api.getWorkspaces();
    const previousWorkspaceId = state.selectedWorkspaceId;
    state.workspaces = data.workspaces || [];
    const nextWorkspaceId = state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId) ?
      state.selectedWorkspaceId : state.workspaces[0]?.id || null;

    if (nextWorkspaceId !== state.selectedWorkspaceId) {
      dispatch({
        type: APP_ACTIONS.SET_SELECTED_WORKSPACE,
        workspaceId: nextWorkspaceId,
      });
    }
    if (previousWorkspaceId !== state.selectedWorkspaceId) {
      resetWorkspacePanels();
    }
    return state.workspaces;
  }

  async function createWorkspace(payload) {
    await runBusy(async () => {
      let data;
      try {
        data = await state.api.createWorkspace({
          name: payload.name,
          source: normalizeCreateWorkspaceSource(payload),
          env: payload.env || {},
        });
      } catch (error) {
        throw new Error(friendlyWorkspaceError(error));
      }
      dispatch({
        type: APP_ACTIONS.SET_SELECTED_WORKSPACE,
        workspaceId: data.workspace.id,
      });
      dispatch({type: APP_ACTIONS.SET_SELECTED_SESSION, sessionId: null});
      resetWorkspacePanels();
      await refreshAll();
    });
  }

  async function deleteWorkspace(workspaceId) {
    const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
    const name = workspace?.name || workspaceId;
    const ok = window.confirm(`Delete workspace ${name}? Sessions will be stopped and workspace files will be removed.`);
    if (!ok) return;

    await runBusy(async () => {
      await state.api.deleteWorkspace(workspaceId);
      if (state.selectedWorkspaceId === workspaceId) {
        dispatch({type: APP_ACTIONS.SET_SELECTED_WORKSPACE, workspaceId: null});
        dispatch({type: APP_ACTIONS.SET_SELECTED_SESSION, sessionId: null});
        resetWorkspacePanels({includeMcp: false});
      }
      await refreshAll();
    });
  }

  async function selectWorkspace(workspaceId) {
    dispatch({type: APP_ACTIONS.SET_ACTIVE_PAGE, page: "workspace"});
    dispatch({type: APP_ACTIONS.SET_SELECTED_WORKSPACE, workspaceId});
    state.sessionModalOpen = false;
    resetWorkspacePanels();
    await runBusy(async () => {
      await loadSessions();
      await loadMcpServers();
      await loadSelectedSessionPanels();
    });
  }

  return {
    createWorkspace,
    deleteWorkspace,
    refreshWorkspaceList,
    selectWorkspace,
  };
}
