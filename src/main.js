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
    actionMessage: "",
    commitMessage: "",
    canOpenPr: false,
  },
  piPackages: {
    loading: false,
    installing: false,
    error: "",
    unavailable: false,
    data: null,
    installSource: "",
    installMessage: "",
  },
  pullRequestForm: {
    open: false,
    title: "",
    body: "",
    branchDescription: "",
    draft: false,
    error: "",
  },
  repoPicker: {
    loading: false,
    error: "",
    repos: [],
    attempted: false,
  },
  drawerCollapsed: false,
  rightDrawerCollapsed: true,
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
        resetPiPackages();
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
    onToggleRightDrawer: toggleRightDrawer,
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
    onRemovePiPackage: removePiPackage,
    onOpenPullRequest: openPullRequestModal,
    onClosePullRequest: closePullRequestModal,
    onUpdatePullRequestForm: updatePullRequestForm,
    onSubmitPullRequest: submitPullRequest,
    onLoadConnectedRepos: loadConnectedRepos,
    onConnectGithub: connectGithub,
  });
}

function resetGitStatus() {
  state.gitStatus = {
    loading: false,
    error: "",
    unavailable: false,
    data: null,
    actionMessage: "",
    commitMessage: "",
    canOpenPr: false,
  };
  resetPullRequestForm();
}

function resetPiPackages() {
  state.piPackages = {
    loading: false,
    installing: false,
    error: "",
    unavailable: false,
    data: null,
    installSource: "",
    installMessage: "",
  };
}

function resetPullRequestForm() {
  state.pullRequestForm = {
    open: false,
    title: "",
    body: "",
    branchDescription: "",
    draft: false,
    error: "",
  };
}

function toggleDrawer() {
  state.drawerCollapsed = !state.drawerCollapsed;
  render();
}

function toggleRightDrawer() {
  state.rightDrawerCollapsed = !state.rightDrawerCollapsed;
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
    }
    await loadSessions();
    await loadGitStatus();
    await loadPiPackages();
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
  await loadPiPackages();
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

async function loadConnectedRepos() {
  if (state.repoPicker.loading || state.repoPicker.attempted) return;
  state.repoPicker = {...state.repoPicker, loading: true, attempted: true};
  render();
  try {
    const data = await state.api.getConnectedRepos();
    state.repoPicker = {loading: false, error: "", repos: data.repos || [], attempted: true};
  } catch (error) {
    state.repoPicker = {loading: false, error: friendlyRepoPickerError(error), repos: [], attempted: true};
  }
  render();
}

async function connectGithub() {
  if (!state.api) return;
  state.repoPicker = {...state.repoPicker, loading: true, error: ""};
  render();
  try {
    const data = await state.api.getGithubConnectUrl();
    if (!data.url) {
      throw new Error("github_connect_url_unavailable");
    }
    window.location.href = data.url;
  } catch (error) {
    state.repoPicker = {
      loading: false,
      error: friendlyRepoPickerError(error),
      repos: [],
      attempted: true,
    };
    render();
  }
}

function friendlyRepoPickerError(error) {
  const message = error.message || "Could not load connected repositories.";
  if (message === "github_app_not_configured") {
    return "github_app_not_configured";
  }
  if (message === "github_oauth_not_configured") {
    return "GitHub OAuth is not configured.";
  }
  if (message === "github_connect_url_unavailable") {
    return "Could not start GitHub connection.";
  }
  return message;
}

function friendlyPiPackageError(error) {
  const message = error.message || "Could not load extensions.";
  if (message === "no_active_session" || message === "session_not_running") {
    return "Start an active pi-basic session to inspect workspace extensions.";
  }
  if (message === "runner_package_listing_unsupported") {
    return "This session runner does not support extension listing yet. Restart or recreate the session after deployment.";
  }
  if (message === "runner_package_list_unavailable") {
    return "The session runner is unavailable. Try refreshing after the terminal is ready.";
  }
  if (message === "pi_package_read_failed" || message === "pi_package_list_failed") {
    return "The runner could not read workspace Pi package settings.";
  }
  return message;
}

function friendlyPiInstallError(error) {
  const message = error.message || "Could not install extension.";
  if (message === "invalid_package_source" || message === "unsupported_package_source") {
    return "Enter a supported npm: or git package source.";
  }
  if (message === "package_operation_busy") {
    return "Another package operation is already running. Try again in a moment.";
  }
  if (message === "runner_package_install_unsupported") {
    return "This session runner does not support extension installs yet. Restart or recreate the session after deployment.";
  }
  if (message === "runner_package_install_unavailable") {
    return "The session runner is unavailable. Try again after the terminal is ready.";
  }
  if (message === "pi_package_install_failed") {
    return "Pi could not install that package source.";
  }
  return message;
}

function friendlyPiRemoveError(error) {
  const message = error.message || "Could not remove extension.";
  if (message === "invalid_package_source" || message === "unsupported_package_source") {
    return "That package source is not valid for removal.";
  }
  if (message === "package_operation_busy") {
    return "Another package operation is already running. Try again in a moment.";
  }
  if (message === "runner_package_remove_unsupported") {
    return "This session runner does not support extension removal yet. Restart or recreate the session after deployment.";
  }
  if (message === "runner_package_remove_unavailable") {
    return "The session runner is unavailable. Try again after the terminal is ready.";
  }
  if (message === "pi_package_remove_failed") {
    return "Pi could not remove that package source.";
  }
  return message;
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
  resetPiPackages();
  await runBusy(async () => {
    await loadSessions();
    await loadGitStatus();
    await loadPiPackages();
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
    await loadPiPackages();
  });
}

async function selectSession(sessionId) {
  state.selectedSessionId = sessionId;
  await loadGitStatus();
  await loadPiPackages();
  render();
}

async function refreshWorkspaceFiles() {
  await runBusy(loadWorkspaceFiles);
}

async function refreshPiPackages() {
  await loadPiPackages();
}

function updatePiInstallSource(source) {
  state.piPackages = {
    ...state.piPackages,
    installSource: source,
    installMessage: "",
    error: "",
  };
  render();
}

async function installPiPackage(source) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const packageSource = String(source || state.piPackages.installSource || "").trim();
  if (!workspaceId || !sessionId || !packageSource) {
    state.piPackages = {
      ...state.piPackages,
      error: packageSource ? "Start an active session before installing." : "Enter an npm: or git package source.",
    };
    render();
    return;
  }

  state.piPackages = {
    ...state.piPackages,
    installing: true,
    error: "",
    installMessage: "Installing package...",
  };
  render();

  try {
    await state.api.installPiPackage(workspaceId, sessionId, packageSource);
    state.piPackages = {
      ...state.piPackages,
      installing: false,
      installSource: "",
      installMessage: "Package installed into this workspace.",
    };
    await loadPiPackages();
  } catch (error) {
    state.piPackages = {
      ...state.piPackages,
      installing: false,
      error: friendlyPiInstallError(error),
      installMessage: "",
    };
    render();
  }
}

async function removePiPackage(source) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const packageSource = String(source || "").trim();
  if (!workspaceId || !sessionId || !packageSource) return;

  state.piPackages = {
    ...state.piPackages,
    installing: true,
    error: "",
    installMessage: "Removing package...",
  };
  render();

  try {
    await state.api.removePiPackage(workspaceId, sessionId, packageSource);
    state.piPackages = {
      ...state.piPackages,
      installing: false,
      installMessage: "Package removed from this workspace.",
    };
    await loadPiPackages();
  } catch (error) {
    state.piPackages = {
      ...state.piPackages,
      installing: false,
      error: friendlyPiRemoveError(error),
      installMessage: "",
    };
    render();
  }
}

async function loadPiPackages() {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) {
    state.piPackages = {
      ...state.piPackages,
      loading: false,
      error: "Select or start an active session to inspect extensions.",
      unavailable: true,
      data: null,
    };
    render();
    return;
  }

  state.piPackages = {
    ...state.piPackages,
    loading: true,
    error: "",
    unavailable: false,
    data: state.piPackages.data || null,
  };
  render();

  try {
    const data = await state.api.getPiPackages(workspaceId, sessionId);
    state.piPackages = {
      ...state.piPackages,
      loading: false,
      error: "",
      unavailable: false,
      data: data || {packages: []},
    };
  } catch (error) {
    state.piPackages = {
      ...state.piPackages,
      loading: false,
      error: friendlyPiPackageError(error),
      unavailable: true,
      data: null,
    };
  }
  render();
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
    actionMessage: state.gitStatus.actionMessage || "",
    commitMessage: state.gitStatus.commitMessage || "",
    canOpenPr: state.gitStatus.canOpenPr || false,
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
        actionMessage: state.gitStatus.actionMessage || "",
        commitMessage: state.gitStatus.commitMessage || "",
        canOpenPr: false,
      };
      render();
      return;
    }
    state.gitStatus = {
      loading: false,
      error: "",
      unavailable: false,
      data: data || null,
      actionMessage: state.gitStatus.actionMessage || "",
      commitMessage: state.gitStatus.commitMessage || "",
      canOpenPr: canOpenPullRequestForSession(getSelectedSession(), data, state.gitStatus.canOpenPr),
    };
  } catch (error) {
    state.gitStatus = {
      loading: false,
      error: friendlyGitStatusError(error),
      unavailable: true,
      data: null,
      actionMessage: state.gitStatus.actionMessage || "",
      commitMessage: state.gitStatus.commitMessage || "",
      canOpenPr: false,
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
  if (message === "runner_git_push_unavailable") {
    return "Git push is temporarily unavailable.";
  }
  if (message === "runner_git_open_pr_unavailable") {
    return "Pull request creation is temporarily unavailable.";
  }
  if (message === "github_auth_not_configured") {
    return "GitHub auth is not configured for push.";
  }
  if (message === "github_pr_requires_connected_repo") {
    return "Pull requests are only supported for connected GitHub repositories.";
  }
  if (message === "missing_pr_branch_description") {
    return "Add a short branch description before opening a PR from the default branch.";
  }
  if (message === "git_pr_branch_name_conflict") {
    return "That mapache/<description> branch name already exists. Choose a different description.";
  }
  if (message === "session_not_running") {
    return "Git status is available once the session is running.";
  }
  return message;
}

async function pullGit() {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) return;

  await runBusy(async () => {
    state.gitStatus = {
      ...state.gitStatus,
      actionMessage: "Pulling latest changes...",
      error: "",
    };
    render();
    const result = await state.api.pullGit(workspaceId, sessionId);
    state.gitStatus = {
      loading: false,
      error: result && result.pull && result.pull.ok === false ? (result.pull.message || "Git pull reported an issue.") : "",
      unavailable: Boolean(result && result.git === false),
      data: result || null,
      actionMessage: result && result.pull && result.pull.ok === false ?
        "Pull completed with Git conflicts or merge issues." :
        "Pull completed.",
    };
    await loadGitStatus();
  });
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
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId || !path) return;

  await runBusy(async () => {
    state.gitStatus = {
      ...state.gitStatus,
      actionMessage,
      error: "",
    };
    render();
    const result = await requestAction(workspaceId, sessionId);
    state.gitStatus = {
      loading: false,
      error: "",
      unavailable: Boolean(result && result.git === false),
      data: result || null,
      actionMessage: `${action === "stage" ? "Staged" : "Unstaged"} ${path}.`,
      commitMessage: state.gitStatus.commitMessage || "",
      canOpenPr: state.gitStatus.canOpenPr || false,
    };
    await loadGitStatus();
  });
}

function updateGitCommitMessage(message) {
  state.gitStatus = {
    ...state.gitStatus,
    commitMessage: message,
  };
}

async function commitGit() {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const message = (state.gitStatus.commitMessage || "").trim();
  if (!workspaceId || !sessionId || !message) return;

  await runBusy(async () => {
    state.gitStatus = {
      ...state.gitStatus,
      actionMessage: "Creating commit...",
      error: "",
    };
    render();
    const result = await state.api.commitGit(workspaceId, sessionId, message);
    state.gitStatus = {
      loading: false,
      error: "",
      unavailable: Boolean(result && result.git === false),
      data: result || null,
      actionMessage: result && result.committedHead ?
        `Committed ${result.committedHead.slice(0, 7)}.` :
        "Commit created.",
      commitMessage: "",
      canOpenPr: state.gitStatus.canOpenPr || false,
    };
    await loadGitStatus();
  });
}

async function pushGit() {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) return;

  await runBusy(async () => {
    state.gitStatus = {
      ...state.gitStatus,
      actionMessage: "Pushing current branch...",
      error: "",
    };
    render();
    try {
      const result = await state.api.pushGit(workspaceId, sessionId);
      state.gitStatus = {
        loading: false,
        error: result && result.push && result.push.ok === false ? (result.push.message || "Git push reported an issue.") : "",
        unavailable: Boolean(result && result.git === false),
        data: result || null,
        actionMessage: result && result.push && result.push.ok === false ?
          "Push completed with Git errors." :
          "Push completed.",
        commitMessage: state.gitStatus.commitMessage || "",
        canOpenPr: result && result.push && result.push.ok === false ? state.gitStatus.canOpenPr : true,
      };
      await loadGitStatus();
    } catch (error) {
      state.gitStatus = {
        ...state.gitStatus,
        error: friendlyGitStatusError(error),
        actionMessage: "",
      };
      render();
    }
  });
}

function openPullRequestModal() {
  state.pullRequestForm = {
    ...state.pullRequestForm,
    open: true,
    error: "",
  };
  render();
}

function closePullRequestModal() {
  resetPullRequestForm();
  render();
}

function updatePullRequestForm(patch) {
  state.pullRequestForm = {
    ...state.pullRequestForm,
    ...patch,
    error: patch && Object.prototype.hasOwnProperty.call(patch, "error") ? patch.error : state.pullRequestForm.error,
  };
  render();
}

async function submitPullRequest() {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) return;

  await runBusy(async () => {
    state.pullRequestForm = {
      ...state.pullRequestForm,
      error: "",
    };
    state.gitStatus = {
      ...state.gitStatus,
      actionMessage: "Opening pull request...",
      error: "",
    };
    render();
    try {
      const result = await state.api.openPullRequest(workspaceId, sessionId, {
        title: state.pullRequestForm.title,
        body: state.pullRequestForm.body,
        branchDescription: state.pullRequestForm.branchDescription,
        draft: state.pullRequestForm.draft,
      });
      state.gitStatus = {
        loading: false,
        error: "",
        unavailable: Boolean(result && result.git === false),
        data: result || null,
        actionMessage: result && result.pullRequest && result.pullRequest.number ?
          `Opened PR #${result.pullRequest.number}.` :
          "Opened pull request.",
        commitMessage: state.gitStatus.commitMessage || "",
        canOpenPr: true,
      };
      const pullRequestUrl = result && result.pullRequest ? result.pullRequest.url : "";
      resetPullRequestForm();
      await loadGitStatus();
      if (pullRequestUrl) {
        window.open(pullRequestUrl, "_blank", "noopener");
      }
    } catch (error) {
      state.pullRequestForm = {
        ...state.pullRequestForm,
        error: friendlyGitStatusError(error),
      };
      state.gitStatus = {
        ...state.gitStatus,
        actionMessage: "",
      };
      render();
    }
  });
}

function getSelectedSession() {
  return state.sessions.find((session) => session.id === state.selectedSessionId) || null;
}

function canOpenPullRequestForSession(session, gitStatus, sticky = false) {
  if (!session || session.sourceMode !== "connected" || !gitStatus || gitStatus.git === false) {
    return false;
  }
  const baseBranch = session.sourceResolvedBranch || session.sourceRequestedBranch || "";
  return Boolean(
      sticky ||
      Number(gitStatus.ahead || 0) > 0 ||
      (gitStatus.branch && baseBranch && gitStatus.branch !== baseBranch),
  );
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

async function deleteSession(sessionId) {
  if (!window.confirm("Delete this session? Running sessions will be stopped first.")) return;

  await runBusy(async () => {
    await state.api.deleteSession(state.selectedWorkspaceId, sessionId);
    const data = await state.api.getSessions(state.selectedWorkspaceId);
    state.sessions = data.sessions || [];
    if (state.selectedSessionId === sessionId) {
      state.selectedSessionId = state.sessions[0] ? state.sessions[0].id : null;
    }
    await loadGitStatus();
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
