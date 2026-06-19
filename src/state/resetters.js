import {
  createAdminState,
  createFileEditorState,
  createGitStatusState,
  createPiAuthState,
  createPiPackagesState,
  createWorkspaceSkillsState,
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

export function resetWorkspaceSkills(state) {
  state.workspaceSkills = createWorkspaceSkillsState();
}

export const resetPiSkills = resetWorkspaceSkills;

export function resetFileEditor(state) {
  state.fileEditor = createFileEditorState();
}

export function resetAdmin(state) {
  state.admin = createAdminState();
}

export function resetWorkspaceFiles(state) {
  state.workspaceFiles = [];
  state.workspaceFilesError = "";
  state.workspaceFilesUploading = false;
  state.workspaceFilesUploadMessage = "";
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
  state.workspaceFilesUploading = false;
  state.workspaceFilesUploadMessage = "";
  state.workspaceFilesTruncated = false;
  state.workspaceFilesWorkspaceId = null;
  state.expandedFilePaths = new Set();
  state.selectedWorkspaceFilePath = "";
  resetFileEditor(state);
  state.profile = null;
  resetAdmin(state);
  state.selectedWorkspaceId = null;
  state.selectedSessionId = null;
  state.collapsedDrawerSections = new Set();
  resetGitStatus(state);
  resetPiPackages(state);
  resetWorkspaceSkills(state);
  resetPiAuth(state);
}
