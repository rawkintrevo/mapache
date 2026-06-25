import {
  createAdminState,
  createFileEditorState,
  createGitStatusState,
  createMcpServersState,
  createPiAuthState,
  createPiPackagesState,
  createWorkspaceSubagentsState,
  createWorkspaceSkillsState,
  createPullRequestFormState,
  createSshForwardsState,
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

export function resetWorkspaceSubagents(state) {
  state.workspaceSubagents = createWorkspaceSubagentsState();
}

export function resetMcpServers(state) {
  state.mcpServers = createMcpServersState();
}

export function resetFileEditor(state) {
  state.fileEditor = createFileEditorState();
}

export function resetAdmin(state) {
  state.admin = createAdminState();
}

export function resetSshForwards(state) {
  state.sshForwards = createSshForwardsState();
}

export function resetWorkspaceFiles(state) {
  state.workspaceFiles = [];
  state.workspaceFilesError = "";
  state.workspaceFileLoadedDirs = new Set();
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
  state.workspaceFileLoadedDirs = new Set();
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
  resetWorkspaceSubagents(state);
  resetMcpServers(state);
  resetPiAuth(state);
  resetSshForwards(state);
}
