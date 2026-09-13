import {render, screen, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {AppShell} from "../components/layout/AppShell.jsx";
import {
  createGithubConnectionState,
  createInitialState,
  createPiAuthState,
} from "../state/initialState.js";

const workspace = {id: "workspace-1", name: "Dev Workspace", source: {type: "blank"}};
const session = {
  id: "session-1",
  name: "Pi smoke",
  status: "running",
  serviceUrl: "https://runner.example",
  terminalKind: "pi",
  imageKey: "pi-chrome",
  resources: {cpu: "1", memory: "1Gi"},
  capabilities: {terminal: true, preview: true, previewQa: true, chrome: true},
};

function handlerGroup() {
  const handlers = new Map();
  return new Proxy({}, {
    get(_target, property) {
      if (!handlers.has(property)) handlers.set(property, vi.fn());
      return handlers.get(property);
    },
  });
}

function createHandlers() {
  const handlers = {
    admin: handlerGroup(),
    app: handlerGroup(),
    drawer: handlerGroup(),
    github: handlerGroup(),
    google: handlerGroup(),
    modals: handlerGroup(),
    pi: handlerGroup(),
    sessions: handlerGroup(),
    workspaces: handlerGroup(),
  };
  handlers.sessions.getSessionAccessUrls.mockResolvedValue({
    terminalUrl: "https://runner.example/?mapache_access=terminal-token",
    browserUrl: "https://runner.example/browser/?mapache_access=browser-token",
    agentUrl: "https://runner.example/agent/?mapache_access=agent-token",
  });
  return handlers;
}

function createState(overrides = {}) {
  return {
    ...createInitialState(),
    user: {displayName: "Ada", email: "ada@example.com"},
    profile: {displayName: "Ada", email: "ada@example.com"},
    workspaces: [workspace],
    sessions: [session],
    selectedWorkspaceId: workspace.id,
    selectedSessionId: null,
    rightDrawerCollapsed: false,
    piAuth: createPiAuthState(),
    githubConnection: createGithubConnectionState(),
    ...overrides,
  };
}

function renderShell(stateOverrides = {}) {
  const handlers = createHandlers();
  const view = render(<AppShell handlers={handlers} state={createState(stateOverrides)} />);
  return {handlers, ...view};
}

describe("frontend shell ownership", () => {
  test("keeps the left drawer empty and collapsed while exposing workspace lifecycle", () => {
    renderShell({selectedSessionId: session.id});

    expect(screen.queryByRole("heading", {name: "Navigation"})).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", {name: "Sessions"})).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Expand drawer"})).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Pause workspace"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "Authentication Center"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name: "MCP Servers"})).toBeInTheDocument();
    for (const label of ["Files", "Git", "Skills", "Subagents", "Extensions", "Models", "Goals", "Chat"]) {
      expect(screen.queryByText(label, {exact: true})).not.toBeInTheDocument();
    }
  });

  test("keeps session terminal and upstream Agent surfaces available", async () => {
    const user = userEvent.setup();
    renderShell({selectedSessionId: session.id});

    expect(screen.getByRole("tab", {name: "Terminal"})).toBeInTheDocument();
    const agentTab = await screen.findByRole("tab", {name: "Agent"});
    expect(agentTab).toBeInTheDocument();
    await user.click(agentTab);
    expect(screen.getByTitle("Agent Pi smoke")).toBeInTheDocument();
  });

  test("places managed Agent and Chrome controls in the left Logs rail", async () => {
    const user = userEvent.setup();
    const managedSession = {...session, agentUiVersion: "pi-web-ui-v1"};
    renderShell({sessions: [managedSession], selectedSessionId: managedSession.id});

    expect(screen.getByRole("heading", {name: "Logs"})).toBeInTheDocument();
    expect(await screen.findByRole("tab", {name: "Agent"})).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", {name: "Persistent Chrome"})).toBeInTheDocument();
    expect(screen.queryByRole("tab", {name: "Preview"})).not.toBeInTheDocument();
    expect(screen.getByTitle("Agent Pi smoke")).toBeInTheDocument();
    expect(screen.queryByRole("region", {name: "Agent runtime status"})).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", {name: "Persistent Chrome"}));
    expect(await screen.findByTitle("Chrome Pi smoke")).toBeInTheDocument();
  });

  test("retains workspace modal entry point without a session creation control", async () => {
    const user = userEvent.setup();
    const {handlers} = renderShell();

    await user.click(screen.getByRole("button", {name: "Create workspace"}));
    expect(handlers.modals.openWorkspaceModal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", {name: "Create session"})).not.toBeInTheDocument();
  });

  test("renders Pi credential management without a models editor", async () => {
    renderShell({piAuthManageModalOpen: true, selectedSessionId: session.id});

    expect(await screen.findByRole("dialog", {name: "Manage Pi Auth"})).toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Inspect/edit models.json"})).not.toBeInTheDocument();
  });

  test("renders the retained GitHub connector on the profile page", async () => {
    renderShell({
      activePage: "profile",
      githubConnection: createGithubConnectionState({
        data: {connected: true, connectionStatus: "connected", githubLogin: "octocat", installationCount: 1},
      }),
    });

    expect(await screen.findByRole("heading", {name: "GitHub"})).toBeInTheDocument();
    expect(screen.getByText("@octocat")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).queryByText("Models")).not.toBeInTheDocument();
  });
});
