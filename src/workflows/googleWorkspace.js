import {friendlyMcpConfigError} from "../utils/friendlyErrors.js";

function selectedServices(state) {
  return Array.isArray(state.googleWorkspace?.selectedServices) ? state.googleWorkspace.selectedServices : [];
}

function workspaceData(data, connections) {
  return {
    ...(data || {}),
    connections: Array.isArray(connections?.connections) ? connections.connections : [],
  };
}

export function updateGoogleWorkspaceSelectionState(state, serviceKey, selected) {
  const next = new Set(selectedServices(state));
  if (selected) next.add(serviceKey);
  else next.delete(serviceKey);
  state.googleWorkspace = {...state.googleWorkspace, selectedServices: [...next]};
}

export function updateGoogleWorkspaceAccessState(state, accessLevel) {
  state.googleWorkspace = {
    ...state.googleWorkspace,
    accessLevel: accessLevel === "write" ? "write" : "read",
  };
}

export async function loadGoogleWorkspaceState({state, render, silent = false}) {
  const workspaceId = state.selectedWorkspaceId;
  if (!workspaceId || !state.api) {
    state.googleWorkspace = {...state.googleWorkspace, loading: false, data: null, attempted: false};
    render();
    return;
  }
  state.googleWorkspace = {
    ...state.googleWorkspace,
    loading: true,
    error: silent ? state.googleWorkspace.error : "",
    attempted: true,
  };
  render();
  try {
    const [workspace, connections, catalog] = await Promise.all([
      state.api.getWorkspaceGoogleConnection(workspaceId),
      state.api.getGoogleConnections(),
      state.api.getGoogleWorkspaceServices(),
    ]);
    const services = workspace?.services || catalog?.services || [];
    const current = workspace?.binding?.enabledServices || [];
    state.googleWorkspace = {
      ...state.googleWorkspace,
      loading: false,
      error: "",
      data: workspaceData({...workspace, services}, connections),
      selectedServices: current.length ? current : state.googleWorkspace.selectedServices,
      attempted: true,
    };
  } catch (error) {
    state.googleWorkspace = {
      ...state.googleWorkspace,
      loading: false,
      error: friendlyMcpConfigError(error),
      attempted: true,
    };
  }
  render();
}

export async function startGoogleWorkspaceConnectionState({state, render, openPopup = defaultOpenPopup, loadState}) {
  const workspaceId = state.selectedWorkspaceId;
  const services = selectedServices(state);
  if (!workspaceId) {
    state.googleWorkspace = {...state.googleWorkspace, error: "Select a workspace before connecting Google."};
    render();
    return;
  }
  if (!services.length) {
    state.googleWorkspace = {...state.googleWorkspace, error: "Select at least one Google service."};
    render();
    return;
  }
  state.googleWorkspace = {...state.googleWorkspace, connecting: true, error: "", message: "Opening Google authorization..."};
  render();
  try {
    const data = await state.api.startGoogleConnection(workspaceId, {
      serviceKeys: services,
      accessLevel: state.googleWorkspace.accessLevel || "read",
    });
    const popup = openPopup(data.authorizationUrl);
    if (popup && typeof popup.focus === "function") popup.focus();
    state.googleWorkspace = {
      ...state.googleWorkspace,
      connecting: false,
      message: popup ? "Complete Google authorization in the popup, then return here." : "Google authorization opened in a new tab.",
    };
    if (data.authorizationCompleted && typeof loadState === "function") await loadState({silent: true});
    if (popup && typeof loadState === "function") watchPopup(popup, () => loadState({silent: true}));
  } catch (error) {
    state.googleWorkspace = {...state.googleWorkspace, connecting: false, error: friendlyMcpConfigError(error), message: ""};
  }
  render();
}

export async function bindGoogleWorkspaceConnectionState({state, render, connectionId, enabledServices, loadState}) {
  const workspaceId = state.selectedWorkspaceId;
  if (!workspaceId || !connectionId) return;
  state.googleWorkspace = {...state.googleWorkspace, saving: true, error: "", message: "Applying Google services..."};
  render();
  try {
    await state.api.bindGoogleConnection(workspaceId, {
      connectionId,
      enabledServices: enabledServices || selectedServices(state),
    });
    state.googleWorkspace = {...state.googleWorkspace, saving: false, message: "Google services applied. Restart active sessions to load the new MCP servers."};
    await loadState({silent: true});
  } catch (error) {
    state.googleWorkspace = {...state.googleWorkspace, saving: false, error: friendlyMcpConfigError(error), message: ""};
    render();
  }
}

export async function unbindGoogleWorkspaceConnectionState({state, render, loadState}) {
  const workspaceId = state.selectedWorkspaceId;
  if (!workspaceId) return;
  state.googleWorkspace = {...state.googleWorkspace, saving: true, error: "", message: "Disconnecting Google from this workspace..."};
  render();
  try {
    await state.api.unbindGoogleConnection(workspaceId);
    state.googleWorkspace = {...state.googleWorkspace, saving: false, message: "Google disconnected from this workspace. Restart active sessions to clear its MCP servers."};
    await loadState({silent: true});
  } catch (error) {
    state.googleWorkspace = {...state.googleWorkspace, saving: false, error: friendlyMcpConfigError(error), message: ""};
    render();
  }
}

export async function deleteGoogleConnectionState({state, render, connectionId, loadState}) {
  if (!connectionId) return;
  state.googleWorkspace = {...state.googleWorkspace, deleting: true, error: "", message: "Removing Google account..."};
  render();
  try {
    await state.api.deleteGoogleConnection(connectionId);
    state.googleWorkspace = {...state.googleWorkspace, deleting: false, message: "Google account removed."};
    await loadState({silent: true});
  } catch (error) {
    state.googleWorkspace = {...state.googleWorkspace, deleting: false, error: friendlyMcpConfigError(error), message: ""};
    render();
  }
}

function defaultOpenPopup(url) {
  return window.open(url, "mapache-google-oauth", "popup,width=520,height=720");
}

function watchPopup(popup, onClosed) {
  const timer = window.setInterval(() => {
    if (!popup.closed) return;
    window.clearInterval(timer);
    onClosed();
  }, 500);
}
