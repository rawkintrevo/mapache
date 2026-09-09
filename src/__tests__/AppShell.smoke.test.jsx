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
  createPullRequestFormState,
  createRepoPickerState,
  createWorkspaceSkillsState,
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
      createWorkspaceDirectory: vi.fn(),
      createWorkspaceFile: vi.fn(),
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
      closeSessionEditModal: vi.fn(),
      closeSessionModal: vi.fn(),
      closeWorkspaceSkillModal: vi.fn(),
      closeWorkspaceEditModal: vi.fn(),
      closeWorkspaceModal: vi.fn(),
      openAuthModal: vi.fn(),
      openPiAuthManageModal: vi.fn(),
      openSessionEditModal: vi.fn(),
      openSessionModal: vi.fn(),
      openWorkspaceSkillModal: vi.fn(),
      openWorkspaceEditModal: vi.fn(),
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
      editSession: vi.fn(),
      getSessionAccessUrls: vi.fn().mockResolvedValue({terminalUrl: "https://runner.example/terminal"}),
      resizeSession: vi.fn(),
      restartSession: vi.fn(),
      selectSession: vi.fn(),
      stopSession: vi.fn(),
    },
    workspaces: {
      createWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      renameWorkspace: vi.fn().mockResolvedValue(true),
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
    pendingOperations: {},
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
    workspaceSkills: createWorkspaceSkillsState({
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
    sessionEditModalSessionId: null,
    sessions: [session],
    user: {displayName: "Ada", email: "ada@example.com"},
    workspaceFiles: [{path: "README.md"}],
    workspaceFilesError: "",
    workspaceFilesTruncated: false,
    workspaceFilesUploadMessage: "",
    workspaceFilesUploading: false,
    workspaceFilesWorkspaceId: workspace.id,
    workspaceSkillModalOpen: false,
    workspaceEditModalOpen: false,
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
  test("opens the accessible Files action menu and closes it with Escape", async () => {
    const user = userEvent.setup();
    const {handlers} = renderShell();
    const trigger = screen.getByRole("button", {name: "File actions"});

    await user.click(trigger);
    expect(screen.getByRole("menu", {name: "File actions"})).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Upload file",
      "Create file",
      "Create directory",
    ]);

    await user.click(screen.getByRole("menuitem", {name: "Create file"}));
    expect(handlers.files.createWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", {name: "File actions"})).not.toBeInTheDocument();

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", {name: "File actions"})).not.toBeInTheDocument();
  });

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

    await user.click((await screen.findAllByRole("button", {name: "Sign up with Google"}))[0]);
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
    await user.click((await screen.findAllByRole("button", {name: "Open app"}))[0]);
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
    expect(screen.queryByRole("heading", {name: "Workspaces"})).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", {name: "Workspace"})).toHaveValue(workspace.id);
    expect(screen.getByRole("heading", {name: "Files"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Sessions"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Inspector"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Authentication Center"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Skills"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Extensions"})).toBeInTheDocument();
    expect(screen.queryByRole("button", {name: `Create session in ${workspace.name}`})).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Create workspace"}));
    expect(handlers.modals.openWorkspaceModal).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", {name: `Edit workspace ${workspace.name}`}));
    expect(handlers.modals.openWorkspaceEditModal).toHaveBeenCalledTimes(1);

    await user.selectOptions(screen.getByRole("combobox", {name: "Workspace"}), workspace.id);
    expect(handlers.workspaces.selectWorkspace).toHaveBeenCalledWith(workspace.id);

    await user.click(screen.getByRole("button", {name: "Create session"}));
    expect(handlers.modals.openSessionModal).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", {name: `Edit ${session.name}`}));
    expect(handlers.modals.openSessionEditModal).toHaveBeenCalledWith(session.id);
    expect(screen.queryByText("Main Anthropic")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Add authentication provider"})).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("super");
    expect(container).not.toHaveTextContent("tkey");
    expect(screen.queryByText(/User-scoped Pi auth/)).not.toBeInTheDocument();
    expect(screen.queryByText("preview-qa")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Skill name")).not.toBeInTheDocument();
    expect(screen.getByText("npm:@team/workspace-package")).toBeInTheDocument();

    await user.click(screen.getByRole("button", {name: "Manage skills"}));
    expect(handlers.pi.cancelPiSkillEdit).toHaveBeenCalledTimes(1);
    expect(handlers.modals.openWorkspaceSkillModal).toHaveBeenCalledTimes(1);

    const sessionRows = screen.getAllByRole("button", {name: /Pi smoke/i});
    await user.click(sessionRows[0]);
    expect(handlers.sessions.selectSession).toHaveBeenCalledWith(session.id);
  });

  test("renders a selected running session without live runner access", async () => {
    const user = userEvent.setup();
    const {handlers} = renderShell({selectedSessionId: session.id});

    expect(screen.getByText("Terminal access is not ready.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", {name: "Manage Pi Auth"})[0]).toBeInTheDocument();

    await user.click(screen.getByRole("button", {name: "Restart"}));
    expect(handlers.sessions.restartSession).toHaveBeenCalledWith(session.id);

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
    renderShell({
      pendingOperations: {
        "app.refresh": {count: 1, message: "Refreshing workspace...", order: 1},
      },
    });

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

    expect(await screen.findByRole("heading", {name: "GitHub"})).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", {name: "Admin"})).toBeInTheDocument();
    expect(await screen.findByText("Grace")).toBeInTheDocument();
    expect(screen.getByText("$0.025")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox"));
    expect(handlers.admin.setAdminUserWhitelisted).toHaveBeenCalledWith("uid-1", false);
  });

  test("submits create session and create workspace modal flows", async () => {
    const user = userEvent.setup();
    const {handlers: sessionHandlers, unmount} = renderShell({sessionModalOpen: true});

    const sessionDialog = await screen.findByRole("dialog", {name: "New session"});
    expect(within(sessionDialog).queryByLabelText("Session type")).not.toBeInTheDocument();
    expect(within(sessionDialog).getByLabelText("Container image")).toBeInTheDocument();
    await user.type(within(sessionDialog).getByLabelText("Name"), "Agent Shell");
    await user.click(within(sessionDialog).getByRole("button", {name: "Create session"}));

    expect(sessionHandlers.sessions.createSession).toHaveBeenCalledWith({
      cpu: "1",
      env: {},
      imageKey: "default",
      memory: "2Gi",
      name: "Agent Shell",
      sessionType: "cloud",
    });

    unmount();
    const workspaceHandlers = createHandlers();
    const workspaceView = render(
        <AppShell
          handlers={workspaceHandlers}
          state={createState({sessionModalOpen: false, workspaceModalOpen: true})}
        />,
    );

    const workspaceDialog = await screen.findByRole("dialog", {name: "Create Workspace"});
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

  test("renames the selected workspace from the edit modal", async () => {
    const user = userEvent.setup();
    const handlers = createHandlers();
    render(
        <AppShell
          handlers={handlers}
          state={createState({workspaceEditModalOpen: true})}
        />,
    );

    const dialog = await screen.findByRole("dialog", {name: "Edit workspace"});
    const nameInput = within(dialog).getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Workspace");
    await user.click(within(dialog).getByRole("button", {name: "Save changes"}));

    expect(handlers.workspaces.renameWorkspace).toHaveBeenCalledWith(workspace.id, "Renamed Workspace");
    expect(handlers.modals.closeWorkspaceEditModal).toHaveBeenCalledTimes(1);
  });

  test("create session modal derives ssh sessions from dev machine workspaces", async () => {
    const user = userEvent.setup();
    const sshWorkspace = {
      ...workspace,
      source: {
        target: {
          host: "dev.example.com",
          username: "developer",
        },
        type: "ssh",
      },
    };
    const {handlers} = renderShell({
      sessionModalOpen: true,
      workspaces: [sshWorkspace],
    });

    const sessionDialog = await screen.findByRole("dialog", {name: "New session"});
    expect(within(sessionDialog).queryByLabelText("Session type")).not.toBeInTheDocument();
    expect(within(sessionDialog).queryByLabelText("Container image")).not.toBeInTheDocument();
    expect(within(sessionDialog).getByText("This session will connect to developer@dev.example.com.")).toBeInTheDocument();

    await user.type(within(sessionDialog).getByLabelText("Name"), "Dev shell");
    await user.click(within(sessionDialog).getByRole("button", {name: "Create session"}));

    expect(handlers.sessions.createSession).toHaveBeenCalledWith({
      cpu: "1",
      env: {},
      memory: "1Gi",
      name: "Dev shell",
      sessionType: "ssh",
    });
  });

  test("submits dev machine workspace source", async () => {
    const user = userEvent.setup();
    const handlers = createHandlers();
    render(
        <AppShell
          handlers={handlers}
          state={createState({workspaceModalOpen: true})}
        />,
    );

    const dialog = await screen.findByRole("dialog", {name: "Create Workspace"});
    await user.type(within(dialog).getByLabelText("Workspace Name"), "Dev Box");
    await user.click(within(dialog).getByLabelText("Dev machine"));
    await user.type(within(dialog).getByLabelText("Host"), "dev.example.com");
    await user.clear(within(dialog).getByLabelText("Username"));
    await user.type(within(dialog).getByLabelText("Username"), "developer");
    await user.type(within(dialog).getByLabelText("Private key"), "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----");
    expect(within(dialog).queryByLabelText("Signed certificate")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", {name: "Create Workspace"}));

    expect(handlers.workspaces.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      name: "Dev Box",
      source: expect.objectContaining({
        type: "ssh",
        sshTarget: expect.objectContaining({
          authMode: "private-key",
          host: "dev.example.com",
          username: "developer",
        }),
      }),
    }));
  });

  test("creates a skill from the management modal", async () => {
    const user = userEvent.setup();
    const handlers = createHandlers();
    handlers.pi.savePiSkill.mockResolvedValue(true);
    render(
        <AppShell
          handlers={handlers}
          state={createState({
            selectedSessionId: session.id,
            workspaceSkillModalOpen: true,
            workspaceSkills: createWorkspaceSkillsState({
              form: {
                content: "# Modal Skill\n\nUse this from a modal.",
                description: "Created from a modal",
                editing: false,
                name: "modal-skill",
              },
            }),
          })}
        />,
    );

    const dialog = await screen.findByRole("dialog", {name: "Manage skills"});
    await user.click(within(dialog).getByRole("button", {name: "Add skill"}));
    expect(within(dialog).getByLabelText("Skill name")).toHaveValue("modal-skill");
    await user.click(within(dialog).getByRole("button", {name: "Create skill"}));
    expect(handlers.pi.savePiSkill).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(dialog).getByRole("button", {name: "Add skill"})).toBeInTheDocument());

    await user.click(within(dialog).getByRole("button", {name: "Close"}));
    expect(handlers.pi.cancelPiSkillEdit).toHaveBeenCalledTimes(2);
    expect(handlers.modals.closeWorkspaceSkillModal).toHaveBeenCalledTimes(1);
  });

  test("manages discovered skills in the workspace skill modal", async () => {
    const user = userEvent.setup();
    const handlers = createHandlers();
    const editableSkill = {
      content: "---\nname: local-skill\ndescription: Local skill\n---\n\nUse it.",
      description: "Local skill",
      discovered: true,
      editable: true,
      name: "local-skill",
      path: ".pi/skills/local-skill/SKILL.md",
    };
    render(
        <AppShell
          handlers={handlers}
          state={createState({
            selectedSessionId: session.id,
            workspaceSkillModalOpen: true,
            workspaceSkills: createWorkspaceSkillsState({data: {skills: [editableSkill]}}),
          })}
        />,
    );

    const dialog = await screen.findByRole("dialog", {name: "Manage skills"});
    expect(within(dialog).getByLabelText("local-skill is discovered")).toBeChecked();
    await user.click(within(dialog).getByRole("button", {name: "Delete local-skill"}));
    expect(handlers.pi.deletePiSkill).toHaveBeenCalledWith("local-skill");
    await user.click(within(dialog).getByRole("button", {name: "Edit local-skill"}));
    expect(handlers.pi.editPiSkill).toHaveBeenCalledWith(editableSkill);
  });
});
