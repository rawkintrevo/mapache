import {
  createAdminState,
  createGoogleWorkspaceState,
  createAutomationsState,
  createMcpServersState,
  createPiAuthState,
} from "./initialState.js";
import {createRequestGrantsState} from "./requestGrantsState.js";

export function resetPiAuth(state) {
  state.piAuth = createPiAuthState();
}

export function resetMcpServers(state) {
  state.mcpServers = createMcpServersState();
}

export function resetRequestGrants(state) {
  state.requestGrants = createRequestGrantsState();
}

export function resetAdmin(state) {
  state.admin = createAdminState();
}

export function resetGoogleWorkspace(state) {
  state.googleWorkspace = createGoogleWorkspaceState();
}

export function resetAutomations(state) {
  state.automations = createAutomationsState();
}

export function resetSignedOutState(state) {
  state.sessionEditModalSessionId = null;
  state.googleWorkspaceManageModalOpen = false;
  state.googleWorkspaceModalOpen = false;
  state.googleWorkspaceReturnToManage = false;
  state.requestGrantsModalOpen = false;
  resetRequestGrants(state);
  state.workspaces = [];
  state.sessions = [];
  resetAdmin(state);
  state.collapsedDrawerSections = new Set();
  resetMcpServers(state);
  resetPiAuth(state);
  resetGoogleWorkspace(state);
  resetAutomations(state);
}
