import {render, screen, waitFor, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {App} from "../App.jsx";
import {AppShell} from "../components/layout/AppShell.jsx";
import {
  createFileEditorState,
  createGitStatusState,
  createGithubConnectionState,
  createPiAuthState,
  createPiPackagesState,
  createPiSkillsState,
  createPullRequestFormState,
  createRepoPickerState,
} from "../state/initialState.js";

const workspace = {
  id: "workspace-1",
  name: "Dev Workspace",
  source: {type: "blank"},
};

const session = {
  id: "session-1",
  name: "Pi smoke",
  status: "running",
  serviceUrl: "https://runner.example",
  terminalKind: "pi",
  imageKey: "pi-basic",
  resources: {
    cpu: "1",
    memory: "1Gi",
  },
  capabilities: {
    terminal: true,
  },
};

function createHandlers(overrides = {}) {
  const handlers = {
    admin: {
      nextAdminUsersPage: vi.fn(),
      previousAdminUsersPage: vi.fn(),
      refreshAdminUsers: vi.fn(),
      setAdminUserWhitelisted: vi.fn(),
      showAdmin: vi.fn(),
    },
    app: {
      refreshAll: vi.fn(),
      signOut: vi.fn(),
    },
    drawer: {
      toggleDrawer: vi.fn(),
      toggleDrawerSection: vi.fn(),
      toggleRightDrawer: vi.fn(),
    },
    files: {
      closeFileEditor: vi.fn(),
      downloadWorkspaceFile: vi.fn(),
      refreshWorkspaceFiles: vi.fn(),
      saveFileEditor: vi.fn(),
      selectWorkspaceFile: vi.fn(),
      toggleWorkspaceFileDir: vi.fn(),
      updateFileEditorContent: vi.fn(),
      uploadWorkspaceFiles: vi.fn(),
    },
    git: {
      closePullRequestModal: vi.fn(),
      commitGit: vi.fn(),
      openPullRequestModal: vi.fn(),
      pullGit: vi.fn(),
      pushGit: vi.fn(),
      stageGitPath: vi.fn(),
      submitPullRequest: vi.fn(),
      unstageGitPath: vi.fn(),
      updateGitCommitMessage: vi.fn(),
      updatePullRequestForm: vi.fn(),
    },
    github: {
      connectGithub: vi.fn(),
      disconnectGithub: vi.fn(),
      loadGithubConnection: vi.fn(),
      loadConnectedRepos: vi.fn(),
      refreshGithubRepositories: vi.fn(),
    },
    modals: {
      closeAuthModal: vi.fn(),
      closePiAuthManageModal: vi.fn(),
      closeSessionModal: vi.fn(),
      closeWorkspaceModal: vi.fn(),
      openAuthModal: vi.fn(),
      openPiAuthManageModal: vi.fn(),
      openSessionModal: vi.fn(),
      openWorkspaceModal: vi.fn(),
      showProfile: vi.fn(),
    },
    pi: {
      cancelPiSkillEdit: vi.fn(),
      deletePiAuthProvider: vi.fn(),
      deletePiSkill: vi.fn(),
      editPiSkill: vi.fn(),
      installPiPackage: vi.fn(),
      refreshPiAuth: vi.fn(),
      refreshPiPackages: vi.fn(),
      refreshPiSkills: vi.fn(),
      removePiPackage: vi.fn(),
      savePiAuthProvider: vi.fn(),
      savePiSkill: vi.fn(),
      saveSessionPiAuthSelection: vi.fn(),
      startOpenAiCodexDeviceLogin: vi.fn(),
      updatePiAuthForm: vi.fn(),
      updatePiInstallSource: vi.fn(),
      updatePiPackage: vi.fn(),
      updatePiSkillForm: vi.fn(),
    },
    sessions: {
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      getSessionAccessUrls: vi.fn().mockResolvedValue({terminalUrl: "https://runner.example/terminal"}),
      resizeSession: vi.fn(),
      restartSession: vi.fn(),
      selectSession: vi.fn(),
      stopSession: vi.fn(),
    },
    workspaces: {
      createWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      selectWorkspace: vi.fn(),
    },
  };

  return {
    ...handlers,
    ...overrides,
  };
}

function createState(overrides = {}) {
  return {
    activePage: "workspace",
    admin: {
      allowList: {enabled: true},
      cursor: "",
      cursorStack: [],
      error: "",
      loading: false,
      nextCursor: "",
      pageSize: 25,
      users: [],
    },
    api: {},
    authModalOpen: false,
    busy: false,
    busyMessage: "",
    collapsedDrawerSections: new Set(),
    drawerCollapsed: false,
    error: "",
    expandedFilePaths: new Set(),
    fileEditor: createFileEditorState(),
    gitStatus: createGitStatusState(),
    githubConnection: createGithubConnectionState(),
    piAuth: createPiAuthState({
      entries: {
        "entry-1": {
          credential: {key: "supersecretkey", type: "api_key"},
          label: "Main Anthropic",
          providerKey: "anthropic",
        },
      },
    }),
    piAuthManageModalOpen: false,
    piPackages: createPiPackagesState({
      data: {
        knownPackages: [{name: "Preview helper", source: "github:team/preview-helper"}],
        packages: [{name: "Workspace package", source: "npm:@team/workspace-package"}],
        userPackages: [],
      },
    }),
    piSkills: createPiSkillsState({
      data: {
        skills: [{
          content: "---\ndescription: Preview QA\n---\n# Preview QA",
          description: "Checks preview builds",
          kind: "workspace",
          name: "preview-qa",
          path: ".pi/skills/preview-qa/SKILL.md",
        }],
      },
      form: {
        content: "# New Skill\n\nAdd instructions for pi here.",
        description: "",
        editing: false,
        name: "",
      },
    }),
    profile: null,
    pullRequestForm: createPullRequestFormState(),
    repoPicker: createRepoPickerState(),
    rightDrawerCollapsed: false,
    selectedSessionId: null,
    selectedWorkspaceFilePath: "",
    selectedWorkspaceId: workspace.id,
    sessionModalOpen: false,
    sessions: [session],
    user: {displayName: "Ada", email: "ada@example.com"},
    workspaceFiles: [{path: "README.md"}],
    workspaceFilesError: "",
    workspaceFilesTruncated: false,
    workspaceFilesUploadMessage: "",
    workspaceFilesUploading: false,
    workspaceFilesWorkspaceId: workspace.id,
    workspaceModalOpen: false,
    workspaces: [workspace],
    ...overrides,
  };
}

function renderShell(stateOverrides = {}, handlerOverrides = {}) {
  const handlers = createHandlers(handlerOverrides);
  const view = render(<AppShell handlers={handlers} state={createState(stateOverrides)} />);
  return {handlers, ...view};
}

describe("frontend smoke coverage", () => {
  test("routes public and signed-in users through the expected app surfaces", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn();
    const onOpenApp = vi.fn();

    const {rerender} = render(
        <App
          appProps={{handlers: createHandlers(), state: createState()}}
          isAppRoute={false}
          onOpenApp={onOpenApp}
          onSignIn={onSignIn}
          user={null}
        />,
    );

    await user.click(screen.getAllByRole("button", {name: "Sign up with Google"})[0]);
    expect(onSignIn).toHaveBeenCalledTimes(1);

    rerender(
        <App
          appProps={{handlers: createHandlers(), state: createState()}}
          isAppRoute={false}
          onOpenApp={onOpenApp}
          onSignIn={onSignIn}
          user={{displayName: "Ada"}}
        />,
    );
    await user.click(screen.getAllByRole("button", {name: "Open app"})[0]);
    expect(onOpenApp).toHaveBeenCalledTimes(1);

    rerender(
        <App
          appProps={{handlers: createHandlers(), state: createState()}}
          isAppRoute={true}
          onOpenApp={onOpenApp}
          onSignIn={onSignIn}
          user={{displayName: "Ada"}}
        />,
    );
    expect(screen.getByRole("heading", {name: "Navigation"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Inspector"})).toBeInTheDocument();
  });

  test("renders the signed-in shell, drawer panels, and session selection wiring", async () => {
    const user = userEvent.setup();
    const {container, handlers} = renderShell({selectedSessionId: session.id});

    expect(screen.getByRole("heading", {name: "Navigation"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Workspaces"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Files"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Sessions"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Inspector"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Authentication Center"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Skills"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Extensions"})).toBeInTheDocument();
    expect(screen.getByText("Main Anthropic")).toBeInTheDocument();
    expect(screen.getByText("API key")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("super");
    expect(container).not.toHaveTextContent("tkey");
    expect(screen.queryByText(/User-scoped Pi auth/)).not.toBeInTheDocument();
    expect(screen.getByText("preview-qa")).toBeInTheDocument();
    expect(screen.getByText("npm:@team/workspace-package")).toBeInTheDocument();

    const sessionRows = screen.getAllByRole("button", {name: /Pi smoke/i});
    await user.click(sessionRows[0]);
    expect(handlers.sessions.selectSession).toHaveBeenCalledWith(session.id);
  });

  test("renders a selected running session without live runner access", async () => {
    const {handlers} = renderShell({selectedSessionId: session.id});

    expect(screen.getByText("Terminal access is not ready.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", {name: "Manage Pi Auth"})[0]).toBeInTheDocument();

    await waitFor(() => {
      expect(handlers.sessions.getSessionAccessUrls).toHaveBeenCalledWith(workspace.id, session.id);
    });
  });

  test("shows Pi auth management only for Pi-based sessions", () => {
    renderShell({
      selectedSessionId: "shell-session",
      sessions: [{
        ...session,
        id: "shell-session",
        imageKey: "ubuntu",
        name: "Shell session",
        terminalKind: "shell",
      }],
    });

    expect(screen.queryByRole("button", {name: "Manage Pi Auth"})).not.toBeInTheDocument();
  });

  test("shows an accessible global action indicator while busy", () => {
    renderShell({busy: true, busyMessage: "Refreshing workspace..."});

    expect(screen.getByRole("status")).toHaveTextContent("Refreshing workspace...");
    expect(screen.getByRole("button", {name: "Refresh app state"})).toBeDisabled();
  });

  test("renders profile GitHub connector controls", async () => {
    const user = userEvent.setup();
    const {handlers} = renderShell({
      activePage: "profile",
      githubConnection: createGithubConnectionState({
        data: {
          connected: true,
          connectionStatus: "connected",
          githubLogin: "octocat",
          installationCount: 1,
        },
      }),
      repoPicker: createRepoPickerState({
        attempted: true,
        repos: [
          {
            fullName: "octocat/mapache",
            installationId: "42",
            repoId: "99",
          },
        ],
      }),
    });

    expect(screen.getByRole("heading", {name: "GitHub"})).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("@octocat")).toBeInTheDocument();

    await user.click(screen.getByRole("button", {name: "Restart OAuth"}));
    expect(handlers.github.connectGithub).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", {name: "Refresh repositories"}));
    expect(handlers.github.refreshGithubRepositories).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", {name: "Disconnect GitHub"}));
    expect(handlers.github.disconnectGithub).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("link", {name: "Manage installation"})).toHaveAttribute(
        "href",
        "https://github.com/settings/installations",
    );
  });

  test("shows admin menu and renders admin users for admin profiles", async () => {
    const user = userEvent.setup();
    const {handlers, rerender} = renderShell({
      profile: {
        displayName: "Ada Admin",
        email: "ada@example.com",
        isAdmin: true,
      },
    });

    await user.click(screen.getByRole("button", {name: /Ada Admin/i}));
    expect(screen.getByRole("menuitem", {name: "Admin"})).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", {name: "Admin"}));
    expect(handlers.admin.showAdmin).toHaveBeenCalledTimes(1);

    rerender(
        <AppShell
          handlers={handlers}
          state={createState({
            activePage: "admin",
            admin: {
              allowList: {enabled: true},
              cursor: "",
              cursorStack: [],
              error: "",
              loading: false,
              nextCursor: "uid-2",
              pageSize: 25,
              users: [{
                costs: {
                  last30DaysUsd: 0.005,
                  lifetimeUsd: 0.025,
                },
                displayName: "Grace",
                email: "grace@example.com",
                uid: "uid-1",
                userType: "",
                whitelisted: true,
              }],
            },
            profile: {
              displayName: "Ada Admin",
              email: "ada@example.com",
              isAdmin: true,
            },
          })}
        />,
    );

    expect(screen.getByRole("heading", {name: "Admin"})).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
    expect(screen.getByText("$0.025")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox"));
    expect(handlers.admin.setAdminUserWhitelisted).toHaveBeenCalledWith("uid-1", false);
  });

  test("submits create session and create workspace modal flows", async () => {
    const user = userEvent.setup();
    const {handlers: sessionHandlers, unmount} = renderShell({sessionModalOpen: true});

    const sessionDialog = screen.getByRole("dialog", {name: "New session"});
    await user.type(within(sessionDialog).getByLabelText("Name"), "Agent Shell");
    await user.click(within(sessionDialog).getByRole("button", {name: "Create session"}));

    expect(sessionHandlers.sessions.createSession).toHaveBeenCalledWith({
      cpu: "1",
      env: {},
      imageKey: "default",
      memory: "1Gi",
      name: "Agent Shell",
    });

    unmount();
    const workspaceHandlers = createHandlers();
    const workspaceView = render(
        <AppShell
          handlers={workspaceHandlers}
          state={createState({sessionModalOpen: false, workspaceModalOpen: true})}
        />,
    );

    const workspaceDialog = screen.getByRole("dialog", {name: "Create Workspace"});
    await user.type(within(workspaceDialog).getByLabelText("Workspace Name"), "Smoke Workspace");
    await user.click(within(workspaceDialog).getByRole("button", {name: "Create Workspace"}));

    expect(workspaceHandlers.workspaces.createWorkspace).toHaveBeenCalledWith({
      branch: null,
      env: {},
      name: "Smoke Workspace",
      repoUrl: "",
      source: {
        repoUrl: "",
        requestedBranch: null,
        type: "blank",
      },
    });
    expect(workspaceHandlers.modals.closeWorkspaceModal).toHaveBeenCalled();
    workspaceView.unmount();
  });
});
