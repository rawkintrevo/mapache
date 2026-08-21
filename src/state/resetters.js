import {
  createAdminState,
  createFileEditorState,
  createGitStatusState,
  createGoogleWorkspaceState,
  createMcpServersState,
  createPiAuthState,
  createPiModelsState,
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

export function resetPiModels(state) {
  state.piModels = createPiModelsState();
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

export function resetGoogleWorkspace(state) {
  state.googleWorkspace = createGoogleWorkspaceState();
}

export function resetWorkspaceFiles(state) {
  state.workspaceFiles = [];
  state.workspaceFilesError = "";
  state.workspaceFileLoadedDirs = new Set();
  state.workspaceFilesUploading = false;
  state.workspaceFilesUploadMessage = "";
  state.workspaceFilesTruncated = false;
  state.workspaceFilesWorkspaceId = state.selectedWorkspaceId;
  state.workspaceFileActiveDirectory = "";
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
  state.workspaceFileActiveDirectory = "";
  state.expandedFilePaths = new Set();
  state.selectedWorkspaceFilePath = "";
  resetFileEditor(state);
  resetAdmin(state);
  state.collapsedDrawerSections = new Set();
  resetGitStatus(state);
  resetPiPackages(state);
  resetPiModels(state);
  resetWorkspaceSkills(state);
  resetWorkspaceSubagents(state);
  resetMcpServers(state);
  resetPiAuth(state);
  resetSshForwards(state);
  resetGoogleWorkspace(state);
}
