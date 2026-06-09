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
  workspaceFiles: [],
  workspaceFilesError: "",
  workspaceFilesTruncated: false,
  workspaceFilesWorkspaceId: null,
  expandedFilePaths: new Set(),
  selectedWorkspaceFilePath: "",
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
        state.workspaceFiles = [];
        state.workspaceFilesError = "";
        state.workspaceFilesTruncated = false;
        state.workspaceFilesWorkspaceId = null;
        state.expandedFilePaths = new Set();
        state.selectedWorkspaceFilePath = "";
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
    onRefreshWorkspaceFiles: refreshWorkspaceFiles,
    onSelectWorkspaceFile: selectWorkspaceFile,
    onToggleWorkspaceFileDir: toggleWorkspaceFileDir,
    onResizeSession: resizeSession,
    onRestartSession: restartSession,
    onStopSession: stopSession,
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
    const previousWorkspaceId = state.selectedWorkspaceId;
    state.workspaces = data.workspaces || [];
    if (!state.selectedWorkspaceId && state.workspaces.length) {
      state.selectedWorkspaceId = state.workspaces[0].id;
    }
    if (!state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)) {
      state.selectedWorkspaceId = state.workspaces[0] ? state.workspaces[0].id : null;
    }
    if (previousWorkspaceId !== state.selectedWorkspaceId) {
      resetWorkspaceFiles();
    }
    await loadSessions();
    await loadWorkspaceFiles();
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

async function loadWorkspaceFiles() {
  state.workspaceFilesError = "";
  state.workspaceFilesWorkspaceId = state.selectedWorkspaceId;
  if (!state.selectedWorkspaceId) return;

  try {
    const data = await state.api.getWorkspaceFiles(state.selectedWorkspaceId);
    state.workspaceFiles = data.files || [];
    state.workspaceFilesTruncated = Boolean(data.truncated);
  } catch (error) {
    state.workspaceFilesError = friendlyFilesError(error);
  }
}

async function createWorkspace({name}) {
  await runBusy(async () => {
    const data = await state.api.createWorkspace({name});
    state.selectedWorkspaceId = data.workspace.id;
    state.selectedSessionId = null;
    resetWorkspaceFiles();
    await refreshAll();
  });
}

async function selectWorkspace(workspaceId) {
  state.selectedWorkspaceId = workspaceId;
  state.sessionModalOpen = false;
  resetWorkspaceFiles();
  await runBusy(async () => {
    await loadSessions();
    await loadWorkspaceFiles();
  });
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

async function refreshWorkspaceFiles() {
  await runBusy(loadWorkspaceFiles);
}

function toggleWorkspaceFileDir(path) {
  const next = new Set(state.expandedFilePaths);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  state.expandedFilePaths = next;
  render();
}

function selectWorkspaceFile(path) {
  state.selectedWorkspaceFilePath = path;
  render();
}

function resetWorkspaceFiles() {
  state.workspaceFiles = [];
  state.workspaceFilesError = "";
  state.workspaceFilesTruncated = false;
  state.workspaceFilesWorkspaceId = state.selectedWorkspaceId;
  state.expandedFilePaths = new Set();
  state.selectedWorkspaceFilePath = "";
}

function friendlyFilesError(error) {
  const message = error.message || "Could not load files.";
  if (message === "not_found") return "Files API is not deployed yet.";
  return message;
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

async function stopSession(sessionId) {
  await runBusy(async () => {
    await state.api.stopSession(state.selectedWorkspaceId, sessionId);
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
