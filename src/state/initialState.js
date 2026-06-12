export function createFileEditorState(overrides = {}) {
  return {
    open: false,
    path: "",
    name: "",
    content: "",
    originalContent: "",
    loading: false,
    saving: false,
    error: "",
    updatedAt: "",
    ...overrides,
  };
}

export function createGitStatusState(overrides = {}) {
  return {
    loading: false,
    error: "",
    unavailable: false,
    data: null,
    actionMessage: "",
    commitMessage: "",
    canOpenPr: false,
    ...overrides,
  };
}

export function createPiPackagesState(overrides = {}) {
  return {
    loading: false,
    installing: false,
    error: "",
    unavailable: false,
    data: null,
    installSource: "",
    installMessage: "",
    ...overrides,
  };
}

export function createPiAuthState(overrides = {}) {
  return {
    loading: false,
    saving: false,
    error: "",
    message: "",
    providers: {},
    selectedProvider: "anthropic",
    apiKey: "",
    openAiCodexDevice: null,
    ...overrides,
  };
}

export function createPullRequestFormState(overrides = {}) {
  return {
    open: false,
    title: "",
    body: "",
    branchDescription: "",
    draft: false,
    error: "",
    ...overrides,
  };
}

export function createRepoPickerState(overrides = {}) {
  return {
    loading: false,
    error: "",
    repos: [],
    attempted: false,
    ...overrides,
  };
}

export function createInitialState() {
  return {
    user: null,
    profile: null,
    api: null,
    workspaces: [],
    sessions: [],
    workspaceFiles: [],
    workspaceFilesError: "",
    workspaceFilesUploading: false,
    workspaceFilesUploadMessage: "",
    workspaceFilesTruncated: false,
    workspaceFilesWorkspaceId: null,
    expandedFilePaths: new Set(),
    selectedWorkspaceFilePath: "",
    fileEditor: createFileEditorState(),
    selectedWorkspaceId: null,
    selectedSessionId: null,
    activePage: "workspace",
    gitStatus: createGitStatusState(),
    piPackages: createPiPackagesState(),
    piAuth: createPiAuthState(),
    pullRequestForm: createPullRequestFormState(),
    repoPicker: createRepoPickerState(),
    drawerCollapsed: false,
    rightDrawerCollapsed: true,
    collapsedDrawerSections: new Set(),
    sessionModalOpen: false,
    authModalOpen: false,
    busy: false,
    error: "",
  };
}
