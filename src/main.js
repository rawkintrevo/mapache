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
  fileEditor: {
    open: false,
    path: "",
    name: "",
    content: "",
    originalContent: "",
    loading: false,
    saving: false,
    error: "",
    updatedAt: "",
  },
  selectedWorkspaceId: null,
  selectedSessionId: null,
  gitStatus: {
    loading: false,
    error: "",
    unavailable: false,
    data: null,
  },
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
        resetFileEditor();
        state.profile = null;
        state.selectedWorkspaceId = null;
        state.selectedSessionId = null;
        resetGitStatus();
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
    onCloseFileEditor: closeFileEditor,
    onUpdateFileEditorContent: updateFileEditorContent,
    onSaveFileEditor: saveFileEditor,
    onToggleWorkspaceFileDir: toggleWorkspaceFileDir,
    onResizeSession: resizeSession,
    onRestartSession: restartSession,
    onStopSession: stopSession,
  });
}

function resetGitStatus() {
  state.gitStatus = {
    loading: false,
    error: "",
    unavailable: false,
    data: null,
  };
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
      resetGitStatus();
    }
    await loadSessions();
    await loadGitStatus();
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
  await loadGitStatus();
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

async function createWorkspace(payload) {
  await runBusy(async () => {
    const data = await state.api.createWorkspace({
      name: payload.name,
      source: payload.source,
    });
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
  resetGitStatus();
  await runBusy(async () => {
    await loadSessions();
    await loadGitStatus();
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
    await loadGitStatus();
  });
}

async function selectSession(sessionId) {
  state.selectedSessionId = sessionId;
  await loadGitStatus();
  render();
}

async function refreshWorkspaceFiles() {
  await runBusy(loadWorkspaceFiles);
}

async function loadGitStatus() {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) {
    resetGitStatus();
    return;
  }

  state.gitStatus = {
    loading: true,
    error: "",
    unavailable: false,
    data: null,
  };
  render();

  try {
    const data = await state.api.getGitStatus(workspaceId, sessionId);
    if (data && data.ok && data.git === false) {
      state.gitStatus = {
        loading: false,
        error: "",
        unavailable: true,
        data,
      };
      render();
      return;
    }
    state.gitStatus = {
      loading: false,
      error: "",
      unavailable: false,
      data: data || null,
    };
  } catch (error) {
    state.gitStatus = {
      loading: false,
      error: friendlyGitStatusError(error),
      unavailable: true,
      data: null,
    };
  }
  render();
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

async function selectWorkspaceFile(path) {
  const workspaceId = state.selectedWorkspaceId;
  state.selectedWorkspaceFilePath = path;
  state.fileEditor = {
    open: true,
    path,
    name: path.split("/").pop(),
    content: "",
    originalContent: "",
    loading: true,
    saving: false,
    error: "",
    updatedAt: "",
  };
  render();
  try {
    const data = await state.api.getWorkspaceFile(workspaceId, path);
    if (
      state.selectedWorkspaceId !== workspaceId ||
      state.fileEditor.path !== path ||
      !state.fileEditor.open
    ) {
      return;
    }
    state.fileEditor = {
      ...state.fileEditor,
      name: data.name || path.split("/").pop(),
      content: data.content || "",
      originalContent: data.content || "",
      loading: false,
      updatedAt: data.updatedAt || "",
    };
  } catch (error) {
    if (
      state.selectedWorkspaceId !== workspaceId ||
      state.fileEditor.path !== path ||
      !state.fileEditor.open
    ) {
      return;
    }
    state.fileEditor = {
      ...state.fileEditor,
      loading: false,
      error: friendlyFilesError(error),
    };
  }
  render();
}

function closeFileEditor() {
  resetFileEditor();
  render();
}

function updateFileEditorContent(content) {
  state.fileEditor.content = content;
}

async function saveFileEditor(content) {
  if (!state.selectedWorkspaceId || !state.fileEditor.path) return;
  state.fileEditor = {
    ...state.fileEditor,
    content,
    saving: true,
    error: "",
  };
  render();
  try {
    const data = await state.api.saveWorkspaceFile(
        state.selectedWorkspaceId,
        state.fileEditor.path,
        content,
    );
    state.fileEditor = {
      ...state.fileEditor,
      content,
      originalContent: content,
      saving: false,
      updatedAt: data.updatedAt || state.fileEditor.updatedAt,
    };
    await loadWorkspaceFiles();
  } catch (error) {
    state.fileEditor = {
      ...state.fileEditor,
      saving: false,
      error: friendlyFilesError(error),
    };
  }
  render();
}

function resetWorkspaceFiles() {
  state.workspaceFiles = [];
  state.workspaceFilesError = "";
  state.workspaceFilesTruncated = false;
  state.workspaceFilesWorkspaceId = state.selectedWorkspaceId;
  state.expandedFilePaths = new Set();
  state.selectedWorkspaceFilePath = "";
  resetFileEditor();
}

function resetFileEditor() {
  state.fileEditor = {
    open: false,
    path: "",
    name: "",
    content: "",
    originalContent: "",
    loading: false,
    saving: false,
    error: "",
    updatedAt: "",
  };
}

function friendlyFilesError(error) {
  const message = error.message || "Could not load files.";
  if (message === "not_found") return "Files API is not deployed yet.";
  return message;
}

function friendlyGitStatusError(error) {
  const message = error.message || "Could not load Git status.";
  if (message === "runner_git_status_unavailable") {
    return "Git status is temporarily unavailable.";
  }
  if (message === "session_not_running") {
    return "Git status is available once the session is running.";
  }
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
