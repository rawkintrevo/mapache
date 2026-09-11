import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {SessionDetail} from "./SessionDetail.jsx";

function session(overrides = {}) {
  return {
    id: "session-1",
    name: "Chrome smoke",
    status: "running",
    serviceUrl: "https://runner.example",
    resources: {cpu: "1", memory: "1Gi"},
    capabilities: {terminal: true, preview: false, chrome: true},
    ...overrides,
  };
}

function renderDetail(overrides = {}, options = {}) {
  const currentSession = session(overrides);
  return render(
      <SessionDetail
        api={options.api}
        busy={options.busy || false}
        gitStatus={null}
        isGithubWorkspace={false}
        session={currentSession}
        sshForwards={{}}
        workspaceId="workspace-1"
        workspaceSessions={options.workspaceSessions || [currentSession]}
        onGetSessionAccessUrls={vi.fn().mockResolvedValue(options.accessUrls || {
          terminalUrl: "https://runner.example/?mapache_access=terminal-token",
          browserUrl: "https://runner.example/browser/?mapache_access=browser-token",
          agentUrl: "https://runner.example/agent/?mapache_access=agent-token",
        })}
        onResizeSession={vi.fn()}
        onRetryProvisioningSession={options.onRetryProvisioningSession}
        onRestartSession={options.onRestartSession || vi.fn()}
      />,
  );
}

describe("SessionDetail Chrome workflow", () => {
  test("places resource meters beside rather than inside the canvas tabs", async () => {
    vi.stubGlobal("WebSocket", class {
      addEventListener() {}
      close() {}
    });
    renderDetail();

    const utilization = await screen.findByLabelText("Resource utilization");
    expect(utilization).toBeInTheDocument();
    expect(screen.getByRole("tablist")).not.toContainElement(utilization);
    vi.unstubAllGlobals();
  });

  test("shows the Chrome canvas only for Chrome-capable sessions", async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole("tab", {name: "Chrome"}));
    expect(await screen.findByTitle("Chrome Chrome smoke")).toHaveAttribute(
        "src",
        "https://runner.example/browser/?mapache_access=browser-token",
    );
  });

  test("mounts the Agent canvas only when signed agent access is supplied", async () => {
    const user = userEvent.setup();
    renderDetail({name: "Embedded agent", capabilities: {terminal: true, preview: false, chrome: true}});

    const agentTab = await screen.findByRole("tab", {name: "Agent"});
    const agentFrame = screen.getByTitle("Agent Embedded agent");
    await user.click(screen.getByRole("tab", {name: "Chrome"}));
    expect(screen.getByTitle("Agent Embedded agent")).toBe(agentFrame);
    await user.click(agentTab);
    expect(screen.getByTitle("Agent Embedded agent")).toBe(agentFrame);
  });

  test("does not offer Agent when the access response omits agentUrl", async () => {
    renderDetail({name: "Legacy Chrome", capabilities: {terminal: true, preview: false, chrome: true}}, {accessUrls: {
      terminalUrl: "https://runner.example/?mapache_access=terminal-token",
      browserUrl: "https://runner.example/browser/?mapache_access=browser-token",
    }});
    expect(await screen.findByRole("tab", {name: "Chrome"})).toBeInTheDocument();
    expect(screen.queryByRole("tab", {name: "Agent"})).not.toBeInTheDocument();
  });

  test("does not add a Chrome canvas to a normal terminal session", () => {
    renderDetail({
      name: "Pi smoke",
      capabilities: {terminal: true, preview: false, chrome: false},
    });

    expect(screen.queryByRole("tab", {name: "Chrome"})).not.toBeInTheDocument();
  });

  test("shows Chat only for a capability-backed Pi session and keeps Terminal first", async () => {
    const user = userEvent.setup();
    renderDetail({
      name: "Pi chat",
      harnessId: "pi",
      capabilities: {terminal: true, preview: false, chrome: false, chat: true},
    });

    expect(await screen.findByRole("tab", {name: "Terminal"})).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", {name: "Chat"})).toBeInTheDocument();
    await user.click(screen.getByRole("tab", {name: "Chat"}));
    expect(screen.getByRole("region", {name: "Chat Pi chat"})).toBeInTheDocument();
    expect(screen.getByText(/Connecting to Pi|Connection lost/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Open Terminal"}));
    expect(screen.getByRole("tab", {name: "Terminal"})).toHaveAttribute("aria-selected", "true");
  });

  test("keeps Terminal and Chat mounted while switching canvases", async () => {
    const sockets = [];
    class PersistentWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.listeners = new Map();
        sockets.push(this);
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", PersistentWebSocket);
    const user = userEvent.setup();
    renderDetail({
      name: "Persistent chat",
      harnessId: "pi",
      capabilities: {terminal: true, preview: false, chrome: false, chat: true},
    });

    const chatTab = await screen.findByRole("tab", {name: "Chat"});
    const terminalFrame = screen.getByTitle("Terminal Persistent chat");
    const chatRegion = screen.getByRole("region", {name: "Chat Persistent chat", hidden: true});
    await user.click(chatTab);
    await user.type(screen.getByRole("textbox", {name: "Message Pi"}), "keep this draft");
    await user.click(screen.getByRole("tab", {name: "Terminal"}));
    expect(screen.getByTitle("Terminal Persistent chat")).toBe(terminalFrame);
    await user.click(chatTab);

    expect(screen.getByRole("region", {name: "Chat Persistent chat"})).toBe(chatRegion);
    expect(screen.getByRole("textbox", {name: "Message Pi"})).toHaveValue("keep this draft");
    expect(sockets.filter((socket) => socket.url.includes("/chat"))).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  test("does not show Chat when capability or signed terminal access is absent", async () => {
    const {rerender} = renderDetail({name: "Shell", capabilities: {terminal: true, chat: false}});
    expect(screen.queryByRole("tab", {name: "Chat"})).not.toBeInTheDocument();

    rerender(
      <SessionDetail
        busy={false}
        gitStatus={null}
        isGithubWorkspace={false}
        session={session({name: "Pi without access", harnessId: "pi", capabilities: {terminal: true, chat: true}})}
        sshForwards={{}}
        workspaceId="workspace-1"
        onGetSessionAccessUrls={vi.fn().mockResolvedValue({})}
        onRestartSession={vi.fn()}
      />,
    );
    await screen.findByText("Terminal access is not ready.");
    expect(screen.queryByRole("tab", {name: "Chat"})).not.toBeInTheDocument();
  });

  test("keeps session sizing out of the terminal detail", () => {
    renderDetail({resources: {cpu: "1", memory: "2Gi"}});
    expect(screen.queryByRole("group", {name: "Session size"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Resize"})).not.toBeInTheDocument();
  });

  test("shows queued provisioning progress and hides restart until a runner exists", () => {
    renderDetail({status: "provisioning", provisioningState: "queued", serviceUrl: null});

    expect(screen.getByText("Queued for provisioning")).toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Restart"})).not.toBeInTheDocument();
  });

  test("shows one retry action for retryable failures", async () => {
    const user = userEvent.setup();
    const onRetryProvisioningSession = vi.fn();
    renderDetail(
        {status: "provision_failed", provisioningRetryable: true, serviceUrl: null},
        {busy: false, onRetryProvisioningSession},
    );

    const retry = screen.getByRole("button", {name: "Retry provisioning"});
    await user.click(retry);
    expect(onRetryProvisioningSession).toHaveBeenCalledOnce();
  });

  test("shows restart for non-retryable provisioning failures", async () => {
    const user = userEvent.setup();
    const onRestartSession = vi.fn();
    renderDetail(
        {status: "provision_failed", provisioningRetryable: false, serviceUrl: null},
        {onRestartSession},
    );
    expect(screen.queryByRole("button", {name: "Retry provisioning"})).not.toBeInTheDocument();
    const restart = screen.getByRole("button", {name: "Restart"});
    await user.click(restart);
    expect(onRestartSession).toHaveBeenCalledWith("session-1");
  });

  test("disables retry while another operation is pending", () => {
    renderDetail(
        {status: "provision_failed", provisioningRetryable: true, serviceUrl: null},
        {busy: true, onRetryProvisioningSession: vi.fn()},
    );
    expect(screen.getByRole("button", {name: "Retry provisioning"})).toBeDisabled();
  });

  test("emphasizes restart when the running image is stale", () => {
    renderDetail({runnerImageFreshness: "stale"});
    const restart = screen.getByRole("button", {name: "Restart session to pick up the latest container image"});
    expect(restart).toHaveClass("session-restart-button--stale");
    expect(restart).toHaveAttribute("title", "Restart to pick up the latest container image");
    expect(screen.getByText("Stale image")).toBeInTheDocument();
    expect(screen.getByText(/older runner image/)).toBeInTheDocument();
  });

  test("opens the Goal controls below the session canvas and removes preview publishing actions", async () => {
    const user = userEvent.setup();
    const api = {listGoals: vi.fn().mockResolvedValue({goals: []})};
    renderDetail({
      harnessId: "pi",
      capabilities: {terminal: true, preview: true, chrome: false},
    }, {api});

    expect(screen.queryByRole("button", {name: "Share Preview"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Publish"})).not.toBeInTheDocument();

    const goalButton = screen.getByRole("button", {name: "Goal"});
    expect(goalButton).toHaveAttribute("aria-expanded", "false");
    await user.click(goalButton);

    expect(goalButton).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("heading", {name: "Goals"})).toBeInTheDocument();
    expect(api.listGoals).toHaveBeenCalledWith("workspace-1");
  });

  test("opens a separate shell tied to the selected runner", async () => {
    const user = userEvent.setup();
    renderDetail({name: "Shell session"});

    const shellButton = await screen.findByRole("button", {name: "Shell"});
    expect(shellButton).toBeEnabled();
    await user.click(shellButton);

    expect(await screen.findByTitle("Shell Shell session")).toHaveAttribute(
        "src",
        "https://runner.example/shell?mapache_access=terminal-token",
    );
  });
});
