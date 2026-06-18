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

export function createPiSkillsState(overrides = {}) {
  return {
    loading: false,
    saving: false,
    error: "",
    message: "",
    unavailable: false,
    data: null,
    form: {
      name: "",
      description: "",
      content: "# New Skill\n\nAdd instructions for pi here.",
      editing: false,
    },
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
    entries: {},
    selectedProvider: "anthropic",
    apiKey: "",
    entryLabel: "",
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

export function createGithubConnectionState(overrides = {}) {
  return {
    loading: false,
    refreshing: false,
    disconnecting: false,
    error: "",
    message: "",
    data: null,
    attempted: false,
    ...overrides,
  };
}

export function createAdminState(overrides = {}) {
  return {
    users: [],
    pageSize: 25,
    cursor: "",
    cursorStack: [],
    nextCursor: "",
    loading: false,
    error: "",
    allowList: null,
    ...overrides,
  };
}

export function createInitialState() {
  return {
    user: null,
    profile: null,
    admin: createAdminState(),
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
    piSkills: createPiSkillsState(),
    piAuth: createPiAuthState(),
    pullRequestForm: createPullRequestFormState(),
    repoPicker: createRepoPickerState(),
    githubConnection: createGithubConnectionState(),
    drawerCollapsed: false,
    rightDrawerCollapsed: true,
    collapsedDrawerSections: new Set(),
    sessionModalOpen: false,
    authModalOpen: false,
    piAuthManageModalOpen: false,
    busy: false,
    busyMessage: "",
    error: "",
  };
}
