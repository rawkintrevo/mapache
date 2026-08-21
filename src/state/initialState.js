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

export function createPiModelsState(overrides = {}) {
  return {
    loading: false,
    saving: false,
    error: "",
    models: [],
    scopedModels: [],
    ...overrides,
  };
}

export function createWorkspaceSkillsState(overrides = {}) {
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
      content: "# New Skill\n\nAdd instructions for the active agent here.",
      editing: false,
    },
    ...overrides,
  };
}

export const createPiSkillsState = createWorkspaceSkillsState;

export function createWorkspaceSubagentsState(overrides = {}) {
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
      instructions: "Describe the specialized work this subagent should handle.",
      editing: false,
    },
    ...overrides,
  };
}

export function createMcpServersState(overrides = {}) {
  return {
    loading: false,
    saving: false,
    error: "",
    message: "",
    data: null,
    form: {
      name: "",
      transport: "stdio",
      command: "",
      args: "",
      url: "",
      env: "",
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
    environmentEntries: [],
    environmentForm: {id: "", name: "", label: "", value: ""},
    selectedProvider: "anthropic",
    editEntryId: "",
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

export function createGoogleWorkspaceState(overrides = {}) {
  return {
    loading: false,
    connecting: false,
    saving: false,
    deleting: false,
    error: "",
    message: "",
    data: null,
    attempted: false,
    accessLevel: "read",
    selectedServices: [],
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

export function createSshForwardsState(overrides = {}) {
  return {
    loading: false,
    error: "",
    port: "",
    forwards: [],
    ...overrides,
  };
}

export function createInitialState() {
  return {
    user: null,
    profile: null,
    admin: createAdminState(),
    sshForwards: createSshForwardsState(),
    api: null,
    workspaces: [],
    sessions: [],
    workspaceFiles: [],
    workspaceFilesError: "",
    workspaceFileLoadedDirs: new Set(),
    workspaceFilesUploading: false,
    workspaceFilesUploadMessage: "",
    workspaceFilesTruncated: false,
    workspaceFilesWorkspaceId: null,
    workspaceFileActiveDirectory: "",
    expandedFilePaths: new Set(),
    selectedWorkspaceFilePath: "",
    fileEditor: createFileEditorState(),
    selectedWorkspaceId: null,
    selectedSessionId: null,
    activePage: "workspace",
    gitStatus: createGitStatusState(),
    piPackages: createPiPackagesState(),
    piModels: createPiModelsState(),
    workspaceSkills: createWorkspaceSkillsState(),
    workspaceSubagents: createWorkspaceSubagentsState(),
    mcpServers: createMcpServersState(),
    piAuth: createPiAuthState(),
    pullRequestForm: createPullRequestFormState(),
    repoPicker: createRepoPickerState(),
    githubConnection: createGithubConnectionState(),
    googleWorkspace: createGoogleWorkspaceState(),
    drawerCollapsed: false,
    rightDrawerCollapsed: true,
    collapsedDrawerSections: new Set(),
    sessionModalOpen: false,
    workspaceSkillModalOpen: false,
    workspaceSubagentModalOpen: false,
    authModalOpen: false,
    authReturnToManage: false,
    piAuthManageModalOpen: false,
    piModelsModalOpen: false,
    genericEnvironmentModalOpen: false,
    pendingOperations: {},
    operationSequence: 0,
    error: "",
  };
}
