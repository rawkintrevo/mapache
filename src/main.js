import "./styles.css";
import {initializeFirebase, signIn, signOut, watchAuth} from "./services/auth.js";
import {createApiClient} from "./services/api.js";
import {renderAppShell, renderAuthScreen, renderFatalError} from "./ui/render.js";

const state = {
  user: null,
  profile: null,
  api: null,
  workspaces: [],
  sessions: [],
  selectedWorkspaceId: null,
  selectedSessionId: null,
  drawerCollapsed: false,
  sessionModalOpen: false,
  busy: false,
  error: "",
};

const root = document.querySelector("#root");

start();

async function start() {
  try {
    const auth = await initializeFirebase();
    watchAuth(auth, async (user) => {
      state.user = user;
      state.api = user ? createApiClient(() => user.getIdToken()) : null;
      state.error = "";
      if (!user) {
        state.workspaces = [];
        state.sessions = [];
        state.profile = null;
        state.selectedWorkspaceId = null;
        state.selectedSessionId = null;
        render();
        return;
      }
      render();
      await refreshAll();
    });
  } catch (error) {
    renderFatalError(root, error);
  }
}

function render() {
  if (!state.user) {
    renderAuthScreen(root, {onSignIn: signIn});
    return;
  }

  renderAppShell(root, {
    state,
    onSignOut: signOut,
    onRefresh: refreshAll,
    onToggleDrawer: toggleDrawer,
    onCreateWorkspace: createWorkspace,
    onSelectWorkspace: selectWorkspace,
    onOpenSessionModal: openSessionModal,
    onCloseSessionModal: closeSessionModal,
    onCreateSession: createSession,
    onSelectSession: selectSession,
    onResizeSession: resizeSession,
    onRestartSession: restartSession,
  });
}

function toggleDrawer() {
  state.drawerCollapsed = !state.drawerCollapsed;
  render();
}

async function refreshAll() {
  await runBusy(async () => {
    const me = await state.api.getMe();
    state.profile = me.user || null;
    const data = await state.api.getWorkspaces();
    state.workspaces = data.workspaces || [];
    if (!state.selectedWorkspaceId && state.workspaces.length) {
      state.selectedWorkspaceId = state.workspaces[0].id;
    }
    if (!state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)) {
      state.selectedWorkspaceId = state.workspaces[0] ? state.workspaces[0].id : null;
    }
    await loadSessions();
  });
}

async function loadSessions() {
  state.sessions = [];
  state.selectedSessionId = null;
  if (!state.selectedWorkspaceId) return;

  const data = await state.api.getSessions(state.selectedWorkspaceId);
  state.sessions = data.sessions || [];
  state.selectedSessionId = state.sessions[0] ? state.sessions[0].id : null;
}

async function createWorkspace({name}) {
  await runBusy(async () => {
    const data = await state.api.createWorkspace({name});
    state.selectedWorkspaceId = data.workspace.id;
    state.selectedSessionId = null;
    await refreshAll();
  });
}

async function selectWorkspace(workspaceId) {
  state.selectedWorkspaceId = workspaceId;
  state.sessionModalOpen = false;
  await runBusy(loadSessions);
}

function openSessionModal() {
  if (!state.selectedWorkspaceId) return;
  state.sessionModalOpen = true;
  render();
}

function closeSessionModal() {
  state.sessionModalOpen = false;
  render();
}

async function createSession(payload) {
  if (!state.selectedWorkspaceId) return;
  await runBusy(async () => {
    const data = await state.api.createSession(state.selectedWorkspaceId, payload);
    state.selectedSessionId = data.session.id;
    const next = await state.api.getSessions(state.selectedWorkspaceId);
    state.sessions = next.sessions || [];
    state.sessionModalOpen = false;
  });
}

function selectSession(sessionId) {
  state.selectedSessionId = sessionId;
  render();
}

async function resizeSession(sessionId, payload) {
  await runBusy(async () => {
    await state.api.resizeSession(state.selectedWorkspaceId, sessionId, payload);
    const data = await state.api.getSessions(state.selectedWorkspaceId);
    state.sessions = data.sessions || [];
    state.selectedSessionId = sessionId;
  });
}

async function restartSession(sessionId) {
  await runBusy(async () => {
    await state.api.restartSession(state.selectedWorkspaceId, sessionId);
    const data = await state.api.getSessions(state.selectedWorkspaceId);
    state.sessions = data.sessions || [];
    state.selectedSessionId = sessionId;
  });
}

async function runBusy(task) {
  state.busy = true;
  state.error = "";
  render();
  try {
    await task();
  } catch (error) {
    state.error = error.message || "Request failed";
  } finally {
    state.busy = false;
    render();
  }
}
