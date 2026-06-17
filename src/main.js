import "./styles.css";
import {createElement as h} from "react";
import {createRoot} from "react-dom/client";
import {App} from "./App.jsx";
import {getFirestoreDb, initializeFirebase, signIn, signOut, watchAuth} from "./services/auth.js";
import {createApiClient} from "./services/api.js";
import {listenToWorkspaceSessions} from "./services/sessionStore.js";
import {createInitialState} from "./state/initialState.js";
import {friendlyGlobalError, friendlyWorkspaceError} from "./utils/friendlyErrors.js";
import {
  resetFileEditor as resetFileEditorState,
  resetGitStatus as resetGitStatusState,
  resetPiAuth as resetPiAuthState,
  resetPiPackages as resetPiPackagesState,
  resetPiSkills as resetPiSkillsState,
  resetPullRequestForm as resetPullRequestFormState,
  resetSignedOutState,
  resetWorkspaceFiles as resetWorkspaceFilesState,
} from "./state/resetters.js";
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
  deletePiAuthProviderState,
  loadPiAuthState,
  savePiAuthProviderState,
  saveSessionPiAuthSelectionState,
  startOpenAiCodexDeviceLoginState,
  updatePiAuthFormState,
} from "./workflows/piAuth.js";
import {
  installPiPackageState,
  loadPiPackagesState,
  removePiPackageState,
  updatePiInstallSourceState,
  updatePiPackageState,
} from "./workflows/piPackages.js";
import {
  cancelPiSkillEditState,
  deletePiSkillState,
  editPiSkillState,
  loadPiSkillsState,
  savePiSkillState,
  updatePiSkillFormState,
} from "./workflows/piSkills.js";
import {
  deleteSessionState,
  resizeSessionState,
  restartSessionState,
  stopSessionState,
  updateSessionPreviewRootState,
} from "./workflows/sessionLifecycle.js";
import {
  closeFileEditorState,
  downloadWorkspaceFileState,
  loadWorkspaceFilesState,
  saveFileEditorState,
  selectWorkspaceFileState,
  toggleWorkspaceFileDirState,
  updateFileEditorContentState,
  uploadWorkspaceFilesState,
} from "./workflows/workspaceFiles.js";

const state = createInitialState();

const rootElement = document.querySelector("#root");
const reactRoot = createRoot(rootElement);
let fatalError = null;
let unsubscribeSessions = null;
let sessionsListenerWorkspaceId = null;

const APP_PATH = "/app";

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
  } catch (error) {
    fatalError = error;
    render();
  }
}

function render() {
  const isAppRoute = isAppPath();
  const appProps = state.user && isAppRoute ? {
    state,
    onSignOut: signOut,
    onRefresh: refreshAll,
    onToggleDrawer: toggleDrawer,
    onToggleRightDrawer: toggleRightDrawer,
    onToggleDrawerSection: toggleDrawerSection,
    onCreateWorkspace: createWorkspace,
    onDeleteWorkspace: deleteWorkspace,
    onSelectWorkspace: selectWorkspace,
    onShowProfile: showProfile,
    onOpenSessionModal: openSessionModal,
    onCloseSessionModal: closeSessionModal,
    onOpenWorkspaceModal: openWorkspaceModal,
    onCloseWorkspaceModal: closeWorkspaceModal,
    onCreateSession: createSession,
    onSelectSession: selectSession,
    onGetSessionAccessUrls: getSessionAccessUrls,
    onRefreshWorkspaceFiles: refreshWorkspaceFiles,
    onDownloadWorkspaceFile: downloadWorkspaceFile,
    onUploadWorkspaceFiles: uploadWorkspaceFiles,
    onSelectWorkspaceFile: selectWorkspaceFile,
    onCloseFileEditor: closeFileEditor,
    onUpdateFileEditorContent: updateFileEditorContent,
    onSaveFileEditor: saveFileEditor,
    onToggleWorkspaceFileDir: toggleWorkspaceFileDir,
    onResizeSession: resizeSession,
    onUpdateSessionPreviewRoot: updateSessionPreviewRoot,
    onRestartSession: restartSession,
    onStopSession: stopSession,
    onDeleteSession: deleteSession,
    onPullGit: pullGit,
    onPushGit: pushGit,
    onStageGitPath: stageGitPath,
    onUnstageGitPath: unstageGitPath,
    onUpdateGitCommitMessage: updateGitCommitMessage,
    onCommitGit: commitGit,
    onRefreshPiPackages: refreshPiPackages,
    onUpdatePiInstallSource: updatePiInstallSource,
    onInstallPiPackage: installPiPackage,
    onRefreshPiSkills: refreshPiSkills,
    onUpdatePiSkillForm: updatePiSkillForm,
    onEditPiSkill: editPiSkill,
    onCancelPiSkillEdit: cancelPiSkillEdit,
    onSavePiSkill: savePiSkill,
    onDeletePiSkill: deletePiSkill,
    onRefreshPiAuth: refreshPiAuth,
    onDeletePiAuthProvider: deletePiAuthProvider,
    onUpdatePiAuthForm: updatePiAuthForm,
    onSavePiAuthProvider: savePiAuthProvider,
    onStartOpenAiCodexDeviceLogin: startOpenAiCodexDeviceLogin,
    onRemovePiPackage: removePiPackage,
    onUpdatePiPackage: updatePiPackage,
    onOpenAuthModal: openAuthModal,
    onCloseAuthModal: closeAuthModal,
    onOpenPiAuthManage: openPiAuthManageModal,
    onClosePiAuthManageModal: closePiAuthManageModal,
    onSaveSessionPiAuthSelection: saveSessionPiAuthSelection,
    onOpenPullRequest: openPullRequestModal,
    onClosePullRequest: closePullRequestModal,
    onUpdatePullRequestForm: updatePullRequestForm,
    onSubmitPullRequest: submitPullRequest,
    onLoadConnectedRepos: loadConnectedRepos,
    onConnectGithub: connectGithub,
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
  resetPiPackagesState(state);
}

function resetPiAuth() {
  resetPiAuthState(state);
}

function resetPiSkills() {
  resetPiSkillsState(state);
}

function resetPullRequestForm() {
  resetPullRequestFormState(state);
}

function toggleDrawer() {
  state.drawerCollapsed = !state.drawerCollapsed;
  render();
}

function toggleRightDrawer() {
  state.rightDrawerCollapsed = !state.rightDrawerCollapsed;
  render();
}

function toggleDrawerSection(sectionId) {
  if (state.collapsedDrawerSections.has(sectionId)) {
    state.collapsedDrawerSections.delete(sectionId);
  } else {
    state.collapsedDrawerSections.add(sectionId);
  }
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
      resetPiPackages();
      resetPiSkills();
    }
    await loadSessions();
    await loadPiAuth();
    await loadWorkspaceFiles();
  });
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

async function loadWorkspaceFiles() {
  await loadWorkspaceFilesState(state);
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
      });
    } catch (error) {
      throw new Error(friendlyWorkspaceError(error));
    }
    state.selectedWorkspaceId = data.workspace.id;
    state.selectedSessionId = null;
    resetWorkspaceFiles();
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
      resetWorkspaceFiles();
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
  resetWorkspaceFiles();
  resetGitStatus();
  resetPiPackages();
  resetPiSkills();
  await runBusy(async () => {
    await loadSessions();
    await loadGitStatus();
    await loadPiPackages();
    await loadPiSkills();
    await loadWorkspaceFiles();
  });
}

function showProfile() {
  state.activePage = "profile";
  state.sessionModalOpen = false;
  render();
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

function openWorkspaceModal() {
  state.workspaceModalOpen = true;
  render();
}

function closeWorkspaceModal() {
  state.workspaceModalOpen = false;
  render();
}

function openAuthModal() {
  state.authModalOpen = true;
  render();
}

function closeAuthModal() {
  state.authModalOpen = false;
  render();
}

function openPiAuthManageModal() {
  state.piAuthManageModalOpen = true;
  if (!state.piAuth.loading) loadPiAuth();
  render();
}

function closePiAuthManageModal() {
  state.piAuthManageModalOpen = false;
  render();
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

async function refreshWorkspaceFiles() {
  await runBusy(loadWorkspaceFiles);
}

async function uploadWorkspaceFiles(files) {
  await uploadWorkspaceFilesState({state, files, loadWorkspaceFiles, render});
}

async function downloadWorkspaceFile() {
  await downloadWorkspaceFileState({state, render});
}

async function refreshPiPackages() {
  await loadPiPackages();
}

async function refreshPiSkills() {
  await loadPiSkills();
}

function updatePiSkillForm(patch) {
  updatePiSkillFormState(state, patch);
  render();
}

function editPiSkill(skill) {
  editPiSkillState(state, skill);
  render();
}

function cancelPiSkillEdit() {
  cancelPiSkillEditState(state);
  render();
}

async function savePiSkill() {
  await savePiSkillState({state, loadPiSkills, render});
}

async function deletePiSkill(name) {
  const skillName = String(name || "").trim();
  if (!skillName) return;
  const ok = window.confirm(`Delete Pi skill ${skillName}? This removes .pi/skills/${skillName}/SKILL.md from the workspace.`);
  if (!ok) return;
  await deletePiSkillState({state, name: skillName, loadPiSkills, render});
}

async function refreshPiAuth() {
  await loadPiAuth({showMessage: true});
}

async function loadPiAuth(options = {}) {
  await loadPiAuthState({state, render, options});
}

function updatePiAuthForm(patch) {
  updatePiAuthFormState(state, patch);
  render();
}

async function deletePiAuthProvider(provider) {
  const providerKey = String(provider || "").trim();
  if (!providerKey) return;
  const ok = window.confirm(`Delete Pi auth provider ${providerKey}? New sessions will no longer receive this credential.`);
  if (!ok) return;
  await deletePiAuthProviderState({state, provider: providerKey, render});
}

async function startOpenAiCodexDeviceLogin() {
  await startOpenAiCodexDeviceLoginState({state, render});
}

async function savePiAuthProvider() {
  await savePiAuthProviderState({state, render});
}

async function saveSessionPiAuthSelection(selection) {
  const session = state.sessions.find((item) => item.id === state.selectedSessionId);
  await saveSessionPiAuthSelectionState({state, session, selection, render});
}

function updatePiInstallSource(source) {
  updatePiInstallSourceState(state, source);
  render();
}

async function installPiPackage(source) {
  await installPiPackageState({state, source, loadPiPackages, render});
}

async function removePiPackage(source) {
  await removePiPackageState({state, source, loadPiPackages, render});
}

async function updatePiPackage(source = "") {
  await updatePiPackageState({state, source, loadPiPackages, render});
}

async function loadPiPackages() {
  await loadPiPackagesState({state, resetPiPackages, render});
}

async function loadPiSkills() {
  await loadPiSkillsState({state, render});
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
  await loadPiPackages();
  await loadPiSkills();
}

async function loadGitStatus() {
  await loadGitStatusState({state, getSelectedSession, resetGitStatus, render});
}

function toggleWorkspaceFileDir(path) {
  toggleWorkspaceFileDirState(state, path);
  render();
}

async function selectWorkspaceFile(path) {
  await selectWorkspaceFileState({state, path, render});
}

function closeFileEditor() {
  closeFileEditorState(state);
  render();
}

function updateFileEditorContent(content) {
  updateFileEditorContentState(state, content);
}

async function saveFileEditor(content) {
  await saveFileEditorState({state, content, loadWorkspaceFiles, render});
}

function resetWorkspaceFiles() {
  resetWorkspaceFilesState(state);
}

function resetFileEditor() {
  resetFileEditorState(state);
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

async function updateSessionPreviewRoot(sessionId, payload) {
  await runBusy(() => updateSessionPreviewRootState(state, sessionId, payload));
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
