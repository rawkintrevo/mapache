import "./styles.css";
import {createElement as h} from "react";
import {createRoot} from "react-dom/client";
import {App} from "./App.jsx";
import {
  getFirestoreDb,
  initializeFirebase,
  maybeSignInWithQaToken,
  signIn,
  signOut,
  watchAuth,
} from "./services/auth.js";
import {createApiClient} from "./services/api.js";
import {listenToWorkspaceSessions} from "./services/sessionStore.js";
import {createInitialState} from "./state/initialState.js";
import {friendlyGlobalError, friendlyWorkspaceError} from "./utils/friendlyErrors.js";
import {
  resetGitStatus as resetGitStatusState,
  resetSignedOutState,
} from "./state/resetters.js";
import {createDrawerController} from "./controllers/drawerController.js";
import {createModalController} from "./controllers/modalController.js";
import {createPiPanelsController} from "./controllers/piPanelsController.js";
import {createWorkspaceFilesController} from "./controllers/workspaceFilesController.js";
import {
  closePullRequestModalState,
  commitGitState,
  loadGitStatusState,
  openPullRequestModalState,
  pullGitState,
  pushGitState,
  runGitFileActionState,
  submitPullRequestState,
  updateGitCommitMessageState,
  updatePullRequestFormState,
} from "./workflows/git.js";
import {connectGithubState, loadConnectedReposState} from "./workflows/githubConnection.js";
import {
  deleteSessionState,
  resizeSessionState,
  restartSessionState,
  stopSessionState,
} from "./workflows/sessionLifecycle.js";

const state = createInitialState();

const rootElement = document.querySelector("#root");
const reactRoot = createRoot(rootElement);
let fatalError = null;
let unsubscribeSessions = null;
let sessionsListenerWorkspaceId = null;

const APP_PATH = "/app";

const drawerController = createDrawerController({state, render});
const workspaceFilesController = createWorkspaceFilesController({state, render, runBusy});
const piPanelsController = createPiPanelsController({state, render});
const modalController = createModalController({
  state,
  render,
  loadPiAuth: piPanelsController.loadPiAuth,
});
const handlers = {
  admin: {
    nextAdminUsersPage,
    previousAdminUsersPage,
    refreshAdminUsers,
    setAdminUserWhitelisted,
    showAdmin,
  },
  app: {
    refreshAll,
    signOut,
  },
  drawer: drawerController,
  files: workspaceFilesController,
  git: {
    closePullRequestModal,
    commitGit,
    openPullRequestModal,
    pullGit,
    pushGit,
    stageGitPath,
    submitPullRequest,
    unstageGitPath,
    updateGitCommitMessage,
    updatePullRequestForm,
  },
  github: {
    connectGithub,
    loadConnectedRepos,
  },
  modals: modalController,
  pi: piPanelsController,
  sessions: {
    createSession,
    deleteSession,
    getSessionAccessUrls,
    resizeSession,
    restartSession,
    selectSession,
    stopSession,
  },
  workspaces: {
    createWorkspace,
    deleteWorkspace,
    selectWorkspace,
  },
};

start();
window.addEventListener("popstate", render);

async function start() {
  try {
    const auth = await initializeFirebase();
    watchAuth(auth, async (user) => {
      state.user = user;
      state.api = user ? createApiClient(() => user.getIdToken()) : null;
      state.error = "";
      if (!user) {
        detachSessionListener();
        resetSignedOutState(state);
        render();
        return;
      }
      render();
      await refreshAll();
    });
    await maybeSignInWithQaToken();
  } catch (error) {
    fatalError = error;
    render();
  }
}

function render() {
  const isAppRoute = isAppPath();
  const appProps = state.user && isAppRoute ? {
    state,
    handlers,
  } : null;

  reactRoot.render(h(App, {
    appProps,
    fatalError,
    isAppRoute,
    onOpenApp: openApp,
    onSignIn: signInAndOpenApp,
    user: state.user,
  }));
}

function isAppPath(pathname = window.location.pathname) {
  return pathname === APP_PATH || pathname.startsWith(`${APP_PATH}/`);
}

function openApp() {
  if (!isAppPath()) {
    window.history.pushState({}, "", APP_PATH);
  }
  render();
}

async function signInAndOpenApp() {
  await signIn();
  openApp();
}

function resetGitStatus() {
  resetGitStatusState(state);
}

function resetPiPackages() {
  piPanelsController.resetPiPackages();
}

function resetPiSkills() {
  piPanelsController.resetPiSkills();
}

async function refreshAll() {
  await runBusy(async () => {
    const me = await state.api.getMe();
    state.profile = me.user || null;
    if (state.activePage === "admin" && state.profile?.isAdmin !== true) {
      state.activePage = "workspace";
    }
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
      workspaceFilesController.resetWorkspaceFiles();
      resetGitStatus();
      resetPiPackages();
      resetPiSkills();
    }
    await loadSessions();
    await piPanelsController.loadPiAuth();
    await workspaceFilesController.loadWorkspaceFiles();
    if (state.activePage === "admin" && state.profile?.isAdmin === true) {
      await loadAdminUsers({cursor: state.admin.cursor, cursorStack: state.admin.cursorStack});
    }
  });
}

async function showAdmin() {
  if (state.profile?.isAdmin !== true) return;
  state.activePage = "admin";
  await loadAdminUsers({cursor: "", cursorStack: []});
}

async function refreshAdminUsers() {
  await loadAdminUsers({cursor: state.admin.cursor, cursorStack: state.admin.cursorStack});
}

async function nextAdminUsersPage() {
  if (!state.admin.nextCursor) return;
  await loadAdminUsers({
    cursor: state.admin.nextCursor,
    cursorStack: [...state.admin.cursorStack, state.admin.cursor],
  });
}

async function previousAdminUsersPage() {
  const cursorStack = [...state.admin.cursorStack];
  const previousCursor = cursorStack.pop();
  if (previousCursor === undefined) return;
  await loadAdminUsers({cursor: previousCursor, cursorStack});
}

async function loadAdminUsers({cursor = "", cursorStack = []} = {}) {
  state.admin.loading = true;
  state.admin.error = "";
  render();
  try {
    const data = await state.api.getAdminUsers({
      cursor,
      pageSize: state.admin.pageSize,
    });
    state.admin = {
      ...state.admin,
      users: data.users || [],
      cursor,
      cursorStack,
      nextCursor: data.nextCursor || "",
      allowList: data.allowList || null,
      loading: false,
      error: "",
    };
  } catch (error) {
    state.admin.loading = false;
    state.admin.error = friendlyGlobalError(error);
  }
  render();
}

async function setAdminUserWhitelisted(uid, whitelisted) {
  state.admin.loading = true;
  state.admin.error = "";
  render();
  try {
    const data = await state.api.setAdminUserWhitelisted(uid, whitelisted);
    const updatedUser = data.user;
    state.admin.users = state.admin.users.map((user) => (
      user.uid === uid && updatedUser ? updatedUser : user
    ));
  } catch (error) {
    state.admin.error = friendlyGlobalError(error);
  } finally {
    state.admin.loading = false;
    render();
  }
}

async function loadSessions() {
  detachSessionListener();
  state.sessions = [];
  state.selectedSessionId = null;
  if (!state.selectedWorkspaceId) return;

  await attachSessionListener(state.selectedWorkspaceId);
}

function attachSessionListener(workspaceId) {
  const db = getFirestoreDb();
  sessionsListenerWorkspaceId = workspaceId;

  return new Promise((resolve) => {
    let resolved = false;
    unsubscribeSessions = listenToWorkspaceSessions(
        db,
        workspaceId,
        (sessions) => {
          const selectedSessionChanged = applySessionSnapshot(workspaceId, sessions);
          if (!resolved) {
            resolved = true;
            resolve();
          }
          void refreshSelectedSessionPanelsAfterSnapshot(selectedSessionChanged);
          render();
        },
        (error) => {
          if (sessionsListenerWorkspaceId !== workspaceId) return;
          state.error = error.message || "Session listener failed";
          if (!resolved) {
            resolved = true;
            resolve();
          }
          render();
        },
    );
  });
}

function detachSessionListener() {
  if (unsubscribeSessions) {
    unsubscribeSessions();
  }
  unsubscribeSessions = null;
  sessionsListenerWorkspaceId = null;
}

function applySessionSnapshot(workspaceId, sessions) {
  if (sessionsListenerWorkspaceId !== workspaceId || state.selectedWorkspaceId !== workspaceId) {
    return false;
  }

  const previousSession = getSelectedSession();
  const previousSessionId = state.selectedSessionId;
  const previousServiceUrl = previousSession?.serviceUrl || "";
  state.sessions = sessions;

  if (!state.sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = state.sessions[0] ? state.sessions[0].id : null;
  }

  const nextSession = getSelectedSession();
  return previousSessionId !== state.selectedSessionId ||
    previousServiceUrl !== (nextSession?.serviceUrl || "");
}

async function refreshSelectedSessionPanelsAfterSnapshot(selectedSessionChanged) {
  if (!selectedSessionChanged) return;
  await loadSelectedSessionPanels();
}

async function loadConnectedRepos() {
  await loadConnectedReposState({state, render});
}

async function connectGithub() {
  await connectGithubState({state, render});
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
    state.selectedWorkspaceId = data.workspace.id;
    state.selectedSessionId = null;
    workspaceFilesController.resetWorkspaceFiles();
    await refreshAll();
  });
}

function normalizeCreateWorkspaceSource(payload = {}) {
  const source = payload.source && typeof payload.source === "object" ? payload.source : {};
  const sourceType = String(source.type || payload.source || "blank").trim().toLowerCase();
  if (sourceType !== "github") {
    return {type: "blank"};
  }

  return {
    ...source,
    type: "github",
    repoUrl: source.repoUrl || payload.repoUrl || "",
    requestedBranch: source.requestedBranch || payload.branch || "",
  };
}

async function deleteWorkspace(workspaceId) {
  const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
  const name = workspace?.name || workspaceId;
  const ok = window.confirm(`Delete workspace ${name}? Sessions will be stopped and workspace files will be removed.`);
  if (!ok) return;

  await runBusy(async () => {
    await state.api.deleteWorkspace(workspaceId);
    if (state.selectedWorkspaceId === workspaceId) {
      state.selectedWorkspaceId = null;
      state.selectedSessionId = null;
      workspaceFilesController.resetWorkspaceFiles();
      resetGitStatus();
      resetPiPackages();
      resetPiSkills();
    }
    await refreshAll();
  });
}

async function selectWorkspace(workspaceId) {
  state.activePage = "workspace";
  state.selectedWorkspaceId = workspaceId;
  state.sessionModalOpen = false;
  workspaceFilesController.resetWorkspaceFiles();
  resetGitStatus();
  resetPiPackages();
  resetPiSkills();
  await runBusy(async () => {
    await loadSessions();
    await loadGitStatus();
    await piPanelsController.loadPiPackages();
    await piPanelsController.loadPiSkills();
    await workspaceFilesController.loadWorkspaceFiles();
  });
}

async function createSession(payload) {
  if (!state.selectedWorkspaceId) return;
  await runBusy(async () => {
    const data = await state.api.createSession(state.selectedWorkspaceId, payload);
    state.selectedSessionId = data.session.id;
    state.sessionModalOpen = false;
    await loadSelectedSessionPanels();
  });
}

async function selectSession(sessionId) {
  state.activePage = "workspace";
  state.selectedSessionId = sessionId;
  await loadSelectedSessionPanels();
  render();
}

async function loadSelectedSessionPanels() {
  if (!getSelectedSession()?.serviceUrl) {
    resetGitStatus();
    resetPiPackages();
    resetPiSkills();
    render();
    return;
  }
  await loadGitStatus();
  await piPanelsController.loadPiPackages();
  await piPanelsController.loadPiSkills();
}

async function loadGitStatus() {
  await loadGitStatusState({state, getSelectedSession, resetGitStatus, render});
}

async function pullGit() {
  await runBusy(() => pullGitState({state, loadGitStatus, render}));
}

async function stageGitPath(path) {
  await runGitFileAction(path, "stage", "Staging file...", (workspaceId, sessionId) => (
    state.api.stageGit(workspaceId, sessionId, [path])
  ));
}

async function unstageGitPath(path) {
  await runGitFileAction(path, "unstage", "Unstaging file...", (workspaceId, sessionId) => (
    state.api.unstageGit(workspaceId, sessionId, [path])
  ));
}

async function runGitFileAction(path, action, actionMessage, requestAction) {
  await runBusy(() => runGitFileActionState({
    state,
    path,
    action,
    actionMessage,
    requestAction,
    loadGitStatus,
    render,
  }));
}

function updateGitCommitMessage(message) {
  updateGitCommitMessageState(state, message);
}

async function commitGit() {
  await runBusy(() => commitGitState({state, loadGitStatus, render}));
}

async function pushGit() {
  await runBusy(() => pushGitState({state, loadGitStatus, render}));
}

function openPullRequestModal() {
  openPullRequestModalState(state);
  render();
}

function closePullRequestModal() {
  closePullRequestModalState(state);
  render();
}

function updatePullRequestForm(patch) {
  updatePullRequestFormState(state, patch);
  render();
}

async function submitPullRequest() {
  await runBusy(() => submitPullRequestState({state, loadGitStatus, render}));
}

function getSelectedSession() {
  return state.sessions.find((session) => session.id === state.selectedSessionId) || null;
}

async function resizeSession(sessionId, payload) {
  await runBusy(() => resizeSessionState(state, sessionId, payload));
}

async function restartSession(sessionId) {
  await runBusy(() => restartSessionState(state, sessionId));
}

async function stopSession(sessionId) {
  await runBusy(() => stopSessionState(state, sessionId));
}

async function deleteSession(sessionId) {
  if (!window.confirm("Delete this session? Running sessions will be stopped first.")) return;

  await runBusy(async () => {
    await deleteSessionState(state, sessionId);
    await loadGitStatus();
  });
}

async function getSessionAccessUrls(workspaceId, sessionId) {
  return state.api.getSessionAccessUrls(workspaceId, sessionId);
}

async function runBusy(task) {
  state.busy = true;
  state.error = "";
  render();
  try {
    await task();
  } catch (error) {
    state.error = friendlyGlobalError(error);
  } finally {
    state.busy = false;
    render();
  }
}
