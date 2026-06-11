import {
  createFileEditorState,
  createGitStatusState,
  createPiAuthState,
  createPiPackagesState,
  createPullRequestFormState,
} from "./initialState.js";

export function resetPullRequestForm(state) {
  state.pullRequestForm = createPullRequestFormState();
}

export function resetGitStatus(state) {
  state.gitStatus = createGitStatusState();
  resetPullRequestForm(state);
}

export function resetPiPackages(state) {
  state.piPackages = createPiPackagesState();
}

export function resetPiAuth(state) {
  state.piAuth = createPiAuthState();
}

export function resetFileEditor(state) {
  state.fileEditor = createFileEditorState();
}

export function resetWorkspaceFiles(state) {
  state.workspaceFiles = [];
  state.workspaceFilesError = "";
  state.workspaceFilesTruncated = false;
  state.workspaceFilesWorkspaceId = state.selectedWorkspaceId;
  state.expandedFilePaths = new Set();
  state.selectedWorkspaceFilePath = "";
  resetFileEditor(state);
}

export function resetSignedOutState(state) {
  state.workspaces = [];
  state.sessions = [];
  state.workspaceFiles = [];
  state.workspaceFilesError = "";
  state.workspaceFilesTruncated = false;
  state.workspaceFilesWorkspaceId = null;
  state.expandedFilePaths = new Set();
  state.selectedWorkspaceFilePath = "";
  resetFileEditor(state);
  state.profile = null;
  state.selectedWorkspaceId = null;
  state.selectedSessionId = null;
  state.collapsedDrawerSections = new Set();
  resetGitStatus(state);
  resetPiPackages(state);
  resetPiAuth(state);
}
