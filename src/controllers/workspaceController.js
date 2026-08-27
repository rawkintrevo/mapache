import {APP_ACTIONS} from "../state/appStore.js";
import {friendlyWorkspaceError} from "../utils/friendlyErrors.js";
import {OPERATION_KEYS} from "../utils/operationKeys.js";

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
  loadGoogleWorkspace = async () => {},
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
    }, "Working...", OPERATION_KEYS.WORKSPACE_CREATE);
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
    }, "Working...", OPERATION_KEYS.WORKSPACE_DELETE);
  }

  async function renameWorkspace(workspaceId, name) {
    const nextName = String(name || "").trim();
    if (!workspaceId || !nextName) return false;

    await runBusy(async () => {
      try {
        await state.api.renameWorkspace(workspaceId, nextName);
        await refreshWorkspaceList();
      } catch (error) {
        throw new Error(friendlyWorkspaceError(error));
      }
    }, "Saving workspace...", OPERATION_KEYS.WORKSPACE_RENAME);
    return !state.error;
  }

  async function selectWorkspace(workspaceId) {
    dispatch({type: APP_ACTIONS.SET_ACTIVE_PAGE, page: "workspace"});
    dispatch({type: APP_ACTIONS.SET_SELECTED_WORKSPACE, workspaceId});
    state.sessionModalOpen = false;
    state.sessionEditModalSessionId = null;
    resetWorkspacePanels();
    await runBusy(async () => {
      await loadSessions();
      await loadMcpServers();
      await loadGoogleWorkspace();
      await loadSelectedSessionPanels();
    }, "Working...", OPERATION_KEYS.WORKSPACE_SELECT);
  }

  return {
    createWorkspace,
    deleteWorkspace,
    refreshWorkspaceList,
    renameWorkspace,
    selectWorkspace,
  };
}
