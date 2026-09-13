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
import {APP_ACTIONS, createAppStore} from "./state/appStore.js";
import {friendlyGlobalError} from "./utils/friendlyErrors.js";
import {
  resetGoogleWorkspace as resetGoogleWorkspaceState,
  resetMcpServers as resetMcpServersState,
  resetSignedOutState,
} from "./state/resetters.js";
import {createAdminController} from "./controllers/adminController.js";
import {createModalController} from "./controllers/modalController.js";
import {createPiPanelsController} from "./controllers/piPanelsController.js";
import {createSessionSubscriptionController} from "./controllers/sessionSubscriptionController.js";
import {createWorkspaceController} from "./controllers/workspaceController.js";
import {createGoogleWorkspaceController} from "./controllers/googleWorkspaceController.js";
import {
  connectGithubState,
  disconnectGithubState,
  loadConnectedReposState,
  loadGithubConnectionState,
  refreshGithubRepositoriesState,
} from "./workflows/githubConnection.js";
import {
  deleteSessionState,
  editSessionState,
  resizeSessionState,
  retryProvisioningSessionState,
  restartSessionState,
  stopSessionState,
} from "./workflows/sessionLifecycle.js";
import {createSessionRequestTracker, isCurrentSessionRequest} from "./utils/sessionRequest.js";
import {OPERATION_KEYS} from "./utils/operationKeys.js";

const appStore = createAppStore(createInitialState());
const state = appStore.state;
const sessionRequestTracker = createSessionRequestTracker(state);

function dispatch(action) {
  appStore.dispatch(action);
}

const rootElement = document.querySelector("#root");
const reactRoot = createRoot(rootElement);
let fatalError = null;

const APP_PATH = "/app";

const adminController = createAdminController({state, render, dispatch});
const piPanelsController = createPiPanelsController({state, render});
const googleWorkspaceController = createGoogleWorkspaceController({state, render});
const sessionSubscriptionController = createSessionSubscriptionController({
  state,
  dispatch,
  render,
  getFirestoreDb,
  listenToWorkspaceSessions,
  onSelectedSessionChanged: loadSelectedSessionAccess,
});
const modalController = createModalController({
  state,
  dispatch,
  render,
  loadGoogleWorkspace: googleWorkspaceController.loadGoogleWorkspace,
  loadMcpServers: piPanelsController.loadMcpServers,
  loadPiAuth: piPanelsController.loadPiAuth,
});
const workspaceController = createWorkspaceController({
  state,
  dispatch,
  runBusy,
  refreshAll,
  loadSessions,
  loadMcpServers: piPanelsController.loadMcpServers,
  loadGoogleWorkspace: googleWorkspaceController.loadGoogleWorkspace,
  loadSelectedSessionAccess,
  resetWorkspacePanels: resetWorkspaceScopedPanels,
});
const handlers = {
  admin: adminController,
  app: {
    refreshAll,
    signOut,
  },
  github: {
    connectGithub,
    disconnectGithub,
    loadGithubConnection,
    loadConnectedRepos,
    refreshGithubRepositories,
  },
  google: googleWorkspaceController,
  modals: modalController,
  pi: piPanelsController,
  sessions: {
    createSession,
    deleteSession,
    editSession,
    getSessionAccessUrls,
    getSessionLogs,
    resizeSession,
    retryProvisioningSession,
    restartSession,
    shareSessionPreview,
    selectSession,
    stopSession,
  },
  workspaces: {
    ...workspaceController,
    toggleWorkspace,
  },
};

start();
window.addEventListener("popstate", render);

async function start() {
  try {
    const auth = await initializeFirebase();
    watchAuth(auth, async (user) => {
      dispatch({
        type: APP_ACTIONS.SET_IDENTITY,
        user,
        api: user ? createApiClient(() => user.getIdToken()) : null,
      });
      if (!user) {
        sessionSubscriptionController.detach();
        resetSignedOutState(state);
        dispatch({type: APP_ACTIONS.RESET_SIGNED_OUT});
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

appStore.subscribe(() => render());

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

function resetMcpServers() {
  resetMcpServersState(state);
}

function resetGoogleWorkspace() {
  resetGoogleWorkspaceState(state);
}

function resetWorkspaceScopedPanels({includeMcp = true} = {}) {
  if (includeMcp) resetMcpServers();
  resetGoogleWorkspace();
}

async function refreshAll() {
  await runBusy(async () => {
    const me = await state.api.getMe();
    dispatch({type: APP_ACTIONS.SET_PROFILE, profile: me.user || null});
    await loadGithubConnectionState({state, render, silent: true});
    if (state.activePage === "admin" && state.profile?.isAdmin !== true) {
      dispatch({type: APP_ACTIONS.SET_ACTIVE_PAGE, page: "workspace"});
    }
    await workspaceController.refreshWorkspaceList();
    await loadSessions();
    await piPanelsController.loadMcpServers();
    await googleWorkspaceController.loadGoogleWorkspace({silent: true});
    await piPanelsController.loadPiAuth();
    if (state.activePage === "admin" && state.profile?.isAdmin === true) {
      await adminController.loadAdminUsers({cursor: state.admin.cursor, cursorStack: state.admin.cursorStack});
    }
  }, "Working...", OPERATION_KEYS.APP_REFRESH);
}

async function loadSessions() {
  await sessionSubscriptionController.loadSessions();
}

async function loadConnectedRepos() {
  await loadConnectedReposState({state, render});
}

async function loadGithubConnection(options = {}) {
  await loadGithubConnectionState({state, render, ...options});
}

async function refreshGithubRepositories() {
  await refreshGithubRepositoriesState({state, render, loadGithubConnection});
}

async function connectGithub() {
  await connectGithubState({state, render});
}

async function disconnectGithub() {
  const ok = window.confirm("Disconnect GitHub from this Mapache account?");
  if (!ok) return;
  await disconnectGithubState({state, render, loadGithubConnection});
}

async function createSession(payload) {
  if (!state.selectedWorkspaceId) return;
  await runBusy(async () => {
    const data = await state.api.createSession(state.selectedWorkspaceId, payload);
    const selectedWorkspace = state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
    if (selectedWorkspace && !selectedWorkspace.canonicalSessionId) {
      selectedWorkspace.canonicalSessionId = data.session.id;
    }
    dispatch({type: APP_ACTIONS.SET_SELECTED_SESSION, sessionId: data.session.id});
    state.sessionModalOpen = false;
    await loadSelectedSessionAccess();
  }, "Working...", OPERATION_KEYS.SESSION_CREATE);
}

async function toggleWorkspace() {
  const workspace = state.workspaces.find((candidate) => candidate.id === state.selectedWorkspaceId);
  if (!workspace) return;
  const session = sessionSubscriptionController.chooseCanonicalSession(state.sessions, workspace.canonicalSessionId);
  const status = String(session?.status || "").toLowerCase();
  if (workspace.source?.type === "ssh" && !["running", "ready"].includes(status)) return;
  if (["provisioning", "queued", "restarting", "resizing", "needs_service", "stopping", "deleting"].includes(status)) return;
  if (session && ["running", "ready"].includes(status)) {
    await stopSession(session.id);
    return;
  }
  if (session) {
    await restartSession(session.id);
    return;
  }
  await createSession({
    name: `${workspace.name} runtime`,
    ...(workspace.resources ? {resources: workspace.resources} : {}),
  });
}

async function selectSession(sessionId) {
  dispatch({type: APP_ACTIONS.SET_ACTIVE_PAGE, page: "workspace"});
  dispatch({type: APP_ACTIONS.SET_SELECTED_SESSION, sessionId});
  await loadSelectedSessionAccess();
  render();
}

async function loadSelectedSessionAccess() {
  const request = sessionRequestTracker.capture();
  if (!request.isCurrent()) return;
  render();
}

async function resizeSession(sessionId, payload) {
  await runBusy(() => resizeSessionState(state, sessionId, payload, dispatch), "Working...", OPERATION_KEYS.SESSION_RESIZE);
}

async function editSession(sessionId, payload) {
  await runBusy(
      () => editSessionState(state, sessionId, payload, dispatch),
      "Saving session...",
      OPERATION_KEYS.SESSION_EDIT,
  );
  return !state.error;
}

async function restartSession(sessionId) {
  await runBusy(() => restartSessionState(state, sessionId, dispatch), "Working...", OPERATION_KEYS.SESSION_RESTART);
}

async function retryProvisioningSession(sessionId) {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session || session.status !== "provision_failed" || session.provisioningRetryable !== true) return;
  if (state.pendingOperations[OPERATION_KEYS.SESSION_RETRY]?.count > 0) return;
  await runBusy(
      () => retryProvisioningSessionState(state, sessionId),
      "Retrying provisioning...",
      OPERATION_KEYS.SESSION_RETRY,
  );
}

async function stopSession(sessionId) {
  await runBusy(() => stopSessionState(state, sessionId, dispatch), "Working...", OPERATION_KEYS.SESSION_STOP);
}

async function deleteSession(sessionId) {
  if (!window.confirm("Delete this session? Running sessions will be stopped first.")) return;

  await runBusy(async () => {
    await deleteSessionState(state, sessionId, dispatch);
    await loadSelectedSessionAccess();
  }, "Working...", OPERATION_KEYS.SESSION_DELETE);
}

async function getSessionAccessUrls(workspaceId, sessionId) {
  return state.api.getSessionAccessUrls(workspaceId, sessionId);
}

async function getSessionLogs(workspaceId, sessionId) {
  return state.api.getSessionLogs(workspaceId, sessionId);
}


async function shareSessionPreview(workspaceId, sessionId) {
  return state.api.shareSessionPreview(workspaceId, sessionId);
}

async function runBusy(task, message = "Working...", operationKey = "global") {
  dispatch({type: APP_ACTIONS.START_OPERATION, key: operationKey, message});
  dispatch({type: APP_ACTIONS.SET_ERROR, error: ""});
  render();
  try {
    await task();
  } catch (error) {
    dispatch({type: APP_ACTIONS.SET_ERROR, error: friendlyGlobalError(error)});
  } finally {
    dispatch({type: APP_ACTIONS.END_OPERATION, key: operationKey});
    render();
  }
}
