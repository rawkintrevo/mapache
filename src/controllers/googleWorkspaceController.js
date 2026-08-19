import {
  bindGoogleWorkspaceConnectionState,
  deleteGoogleConnectionState,
  loadGoogleWorkspaceState,
  startGoogleWorkspaceConnectionState,
  unbindGoogleWorkspaceConnectionState,
  updateGoogleWorkspaceAccessState,
  updateGoogleWorkspaceSelectionState,
} from "../workflows/googleWorkspace.js";
import {resetGoogleWorkspace as resetGoogleWorkspaceState} from "../state/resetters.js";

export function createGoogleWorkspaceController({state, render}) {
  async function loadGoogleWorkspace(options = {}) {
    await loadGoogleWorkspaceState({state, render, ...options});
  }

  function updateService(serviceKey, selected) {
    updateGoogleWorkspaceSelectionState(state, serviceKey, selected);
    render();
  }

  function updateAccessLevel(accessLevel) {
    updateGoogleWorkspaceAccessState(state, accessLevel);
    render();
  }

  async function startConnection() {
    await startGoogleWorkspaceConnectionState({state, render, loadState: loadGoogleWorkspace});
  }

  async function bindConnection(connectionId) {
    await bindGoogleWorkspaceConnectionState({
      state,
      render,
      connectionId,
      loadState: loadGoogleWorkspace,
    });
  }

  async function unbindConnection() {
    await unbindGoogleWorkspaceConnectionState({state, render, loadState: loadGoogleWorkspace});
  }

  async function deleteConnection(connectionId) {
    await deleteGoogleConnectionState({state, render, connectionId, loadState: loadGoogleWorkspace});
  }

  function resetGoogleWorkspace() {
    resetGoogleWorkspaceState(state);
  }

  return {
    bindConnection,
    deleteConnection,
    loadGoogleWorkspace,
    resetGoogleWorkspace,
    startConnection,
    unbindConnection,
    updateAccessLevel,
    updateService,
  };
}
