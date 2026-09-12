import {
  createAdminState,
  createGoogleWorkspaceState,
  createMcpServersState,
  createPiAuthState,
} from "./initialState.js";

export function resetPiAuth(state) {
  state.piAuth = createPiAuthState();
}

export function resetMcpServers(state) {
  state.mcpServers = createMcpServersState();
}

export function resetAdmin(state) {
  state.admin = createAdminState();
}

export function resetGoogleWorkspace(state) {
  state.googleWorkspace = createGoogleWorkspaceState();
}

export function resetSignedOutState(state) {
  state.sessionEditModalSessionId = null;
  state.workspaces = [];
  state.sessions = [];
  resetAdmin(state);
  state.collapsedDrawerSections = new Set();
  resetMcpServers(state);
  resetPiAuth(state);
  resetGoogleWorkspace(state);
}
