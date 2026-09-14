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
    editingConnectionId: "",
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

export function createInitialState() {
  return {
    user: null,
    profile: null,
    admin: createAdminState(),
    api: null,
    workspaces: [],
    sessions: [],
    selectedWorkspaceId: null,
    selectedSessionId: null,
    activePage: "workspace",
    mcpServers: createMcpServersState(),
    piAuth: createPiAuthState(),
    repoPicker: createRepoPickerState(),
    githubConnection: createGithubConnectionState(),
    googleWorkspace: createGoogleWorkspaceState(),
    collapsedDrawerSections: new Set(),
    sessionModalOpen: false,
    sessionEditModalSessionId: null,
    workspaceEditModalOpen: false,
    authModalOpen: false,
    authReturnToManage: false,
    piAuthManageModalOpen: false,
    genericEnvironmentModalOpen: false,
    mcpServersModalOpen: false,
    googleWorkspaceManageModalOpen: false,
    googleWorkspaceModalOpen: false,
    googleWorkspaceReturnToManage: false,
    pendingOperations: {},
    operationSequence: 0,
    error: "",
  };
}
