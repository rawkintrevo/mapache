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
  resetGitStatus as resetGitStatusState,
  resetMcpServers as resetMcpServersState,
  resetSshForwards as resetSshForwardsState,
  resetWorkspaceSubagents as resetWorkspaceSubagentsState,
  resetWorkspaceSkills as resetWorkspaceSkillsState,
  resetSignedOutState,
} from "./state/resetters.js";
import {createAdminController} from "./controllers/adminController.js";
import {createDrawerController} from "./controllers/drawerController.js";
import {createModalController} from "./controllers/modalController.js";
import {createPiPanelsController} from "./controllers/piPanelsController.js";
import {createSessionSubscriptionController} from "./controllers/sessionSubscriptionController.js";
import {createWorkspaceFilesController} from "./controllers/workspaceFilesController.js";
import {createWorkspaceController} from "./controllers/workspaceController.js";
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
import {
  connectGithubState,
  disconnectGithubState,
  loadConnectedReposState,
  loadGithubConnectionState,
  refreshGithubRepositoriesState,
} from "./workflows/githubConnection.js";
import {
  deleteSessionState,
  resizeSessionState,
  retryProvisioningSessionState,
  restartSessionState,
  stopSessionState,
} from "./workflows/sessionLifecycle.js";
import {createSessionRequestTracker, isCurrentSessionRequest} from "./utils/sessionRequest.js";
import {OPERATION_KEYS} from "./utils/operationKeys.js";
import {loadSelectedSessionPanelsConcurrently} from "./workflows/selectedSessionPanels.js";

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

const drawerController = createDrawerController({state, render});
const adminController = createAdminController({state, render, dispatch});
const workspaceFilesController = createWorkspaceFilesController({
  state,
  render,
  runBusy,
  captureSessionRequest: () => sessionRequestTracker.capture(),
});
const piPanelsController = createPiPanelsController({
  state,
  render,
  captureSessionRequest: () => sessionRequestTracker.capture(),
});
const sessionSubscriptionController = createSessionSubscriptionController({
  state,
  dispatch,
  render,
  getFirestoreDb,
  listenToWorkspaceSessions,
  onSelectedSessionChanged: loadSelectedSessionPanels,
});
const modalController = createModalController({
  state,
  dispatch,
  render,
  loadPiAuth: piPanelsController.loadPiAuth,
});
const workspaceController = createWorkspaceController({
  state,
  dispatch,
  runBusy,
  refreshAll,
  loadSessions,
  loadMcpServers: piPanelsController.loadMcpServers,
  loadSelectedSessionPanels,
  resetWorkspacePanels: resetWorkspaceScopedPanels,
});
const handlers = {
  admin: adminController,
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
    disconnectGithub,
    loadGithubConnection,
    loadConnectedRepos,
    refreshGithubRepositories,
  },
  modals: modalController,
  pi: piPanelsController,
  sessions: {
    closeSshSessionForward,
    createSession,
    createSshSessionForward,
    deleteSession,
    getSessionAccessUrls,
    resizeSession,
    retryProvisioningSession,
    restartSession,
    shareSessionPreview,
    selectSession,
    stopSession,
    updateSshForwardPort,
  },
  workspaces: workspaceController,
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

function resetWorkspaceSkills() {
  resetWorkspaceSkillsState(state);
}

function resetWorkspaceSubagents() {
  resetWorkspaceSubagentsState(state);
}

function resetMcpServers() {
  resetMcpServersState(state);
}

function resetSshForwards() {
  resetSshForwardsState(state);
}

function resetWorkspaceScopedPanels({includeMcp = true} = {}) {
  workspaceFilesController.resetWorkspaceFiles();
  resetGitStatus();
  resetPiPackages();
  resetWorkspaceSkills();
  resetWorkspaceSubagents();
  if (includeMcp) resetMcpServers();
  resetSshForwards();
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
    await piPanelsController.loadPiAuth();
    await workspaceFilesController.loadWorkspaceFiles();
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
    dispatch({type: APP_ACTIONS.SET_SELECTED_SESSION, sessionId: data.session.id});
    state.sessionModalOpen = false;
    await loadSelectedSessionPanels();
  }, "Working...", OPERATION_KEYS.SESSION_CREATE);
}

async function selectSession(sessionId) {
  dispatch({type: APP_ACTIONS.SET_ACTIVE_PAGE, page: "workspace"});
  dispatch({type: APP_ACTIONS.SET_SELECTED_SESSION, sessionId});
  await loadSelectedSessionPanels();
  render();
}

async function loadSelectedSessionPanels() {
  const request = sessionRequestTracker.capture();
  const session = getSelectedSession();
  workspaceFilesController.resetWorkspaceFiles();
  if (!session?.serviceUrl) {
    resetGitStatus();
    resetPiPackages();
    resetWorkspaceSkills();
    resetWorkspaceSubagents();
    resetSshForwards();
    await workspaceFilesController.loadWorkspaceFiles("", request);
    if (!request.isCurrent()) return;
    render();
    return;
  }
  if (isSshSession(session)) {
    resetGitStatus();
    resetPiPackages();
    resetWorkspaceSkills();
    resetWorkspaceSubagents();
    await loadSelectedSessionPanelsConcurrently({
      files: () => workspaceFilesController.loadWorkspaceFiles("", request),
      sshForwards: () => loadSshForwards(request),
    });
    if (!request.isCurrent()) return;
    render();
    return;
  }
  await loadSelectedSessionPanelsConcurrently({
    git: () => loadGitStatus(request),
    packages: () => piPanelsController.loadPiPackages(request),
    skills: () => piPanelsController.loadWorkspaceSkills(request),
    subagents: () => piPanelsController.loadWorkspaceSubagents(request),
    files: () => workspaceFilesController.loadWorkspaceFiles("", request),
    sshForwards: () => loadSshForwards(request),
  });
  if (!request.isCurrent()) return;
  render();
}

function isSshSession(session) {
  return session?.sessionType === "ssh" ||
    session?.terminalKind === "ssh" ||
    Boolean(session?.capabilities?.ssh);
}

async function loadGitStatus(request = sessionRequestTracker.capture()) {
  await loadGitStatusState({state, getSelectedSession, resetGitStatus, render, request});
}

async function pullGit() {
  await runBusy(() => pullGitState({state, loadGitStatus, render}), "Working...", OPERATION_KEYS.GIT_PULL);
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
  }), "Working...", action === "stage" ? OPERATION_KEYS.GIT_STAGE : OPERATION_KEYS.GIT_UNSTAGE);
}

function updateGitCommitMessage(message) {
  updateGitCommitMessageState(state, message);
}

async function commitGit() {
  await runBusy(() => commitGitState({state, loadGitStatus, render}), "Working...", OPERATION_KEYS.GIT_COMMIT);
}

async function pushGit() {
  await runBusy(() => pushGitState({state, loadGitStatus, render}), "Working...", OPERATION_KEYS.GIT_PUSH);
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
  await runBusy(() => submitPullRequestState({state, loadGitStatus, render}), "Working...", OPERATION_KEYS.GIT_PULL_REQUEST);
}

function getSelectedSession() {
  return sessionSubscriptionController.getSelectedSession();
}

async function resizeSession(sessionId, payload) {
  await runBusy(() => resizeSessionState(state, sessionId, payload, dispatch), "Working...", OPERATION_KEYS.SESSION_RESIZE);
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
    await loadSelectedSessionPanels();
  }, "Working...", OPERATION_KEYS.SESSION_DELETE);
}

async function getSessionAccessUrls(workspaceId, sessionId) {
  return state.api.getSessionAccessUrls(workspaceId, sessionId);
}

async function shareSessionPreview(workspaceId, sessionId) {
  return state.api.shareSessionPreview(workspaceId, sessionId);
}

function updateSshForwardPort(port) {
  state.sshForwards.port = port;
  render();
}

async function loadSshForwards(request = sessionRequestTracker.capture()) {
  if (!isCurrentSessionRequest(request)) return;
  const session = getSelectedSession();
  if (!session || (session.sessionType !== "ssh" && session.terminalKind !== "ssh") || !session.serviceUrl) {
    resetSshForwards();
    return;
  }
  state.sshForwards.loading = true;
  state.sshForwards.error = "";
  render();
  try {
    const data = await state.api.getSshSessionForwards(state.selectedWorkspaceId, session.id);
    if (!isCurrentSessionRequest(request)) return;
    state.sshForwards.forwards = data.forwards || [];
  } catch (error) {
    if (!isCurrentSessionRequest(request)) return;
    state.sshForwards.error = error.message || "ssh_forwards_unavailable";
  } finally {
    if (isCurrentSessionRequest(request)) state.sshForwards.loading = false;
  }
}

async function createSshSessionForward() {
  const session = getSelectedSession();
  if (!session || !state.sshForwards.port) return;
  await runBusy(async () => {
    await state.api.createSshSessionForward(state.selectedWorkspaceId, session.id, state.sshForwards.port);
    state.sshForwards.port = "";
    await loadSshForwards();
  }, "Working...", OPERATION_KEYS.SSH_FORWARD_CREATE);
}

async function closeSshSessionForward(port) {
  const session = getSelectedSession();
  if (!session) return;
  await runBusy(async () => {
    await state.api.closeSshSessionForward(state.selectedWorkspaceId, session.id, port);
    await loadSshForwards();
  }, "Working...", OPERATION_KEYS.SSH_FORWARD_CLOSE);
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
