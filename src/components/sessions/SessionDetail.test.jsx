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
        busy={options.busy || false}
        isGithubWorkspace={false}
        session={currentSession}
        sshForwards={{}}
        workspaceId="workspace-1"
        onGetSessionAccessUrls={vi.fn().mockResolvedValue(options.accessUrls || {
          terminalUrl: "https://runner.example/?mapache_access=terminal-token",
          browserUrl: "https://runner.example/browser/?mapache_access=browser-token",
          agentUrl: "https://runner.example/agent/?mapache_access=agent-token",
        })}
        onResizeSession={vi.fn()}
        onRetryProvisioningSession={options.onRetryProvisioningSession}
        onRestartSession={options.onRestartSession || vi.fn()}
        onStopSession={options.onStopSession}
      />,
  );
}

describe("SessionDetail Chrome workflow", () => {
  test("makes the embedded Agent the default managed workspace surface", async () => {
    const user = userEvent.setup();
    const onStopSession = vi.fn();
    renderDetail({
      agentUiVersion: "pi-web-ui-v1",
      harnessId: "pi",
      capabilities: {terminal: true, preview: true, chrome: true},
    }, {onStopSession});

    expect(await screen.findByRole("tab", {name: "Agent"})).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", {name: "Persistent Chrome"})).toBeInTheDocument();
    expect(screen.getByRole("tab", {name: "Preview"})).toBeInTheDocument();
    expect(screen.queryByRole("tab", {name: "Terminal"})).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", {name: "Chat"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Models"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Goal"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Shell"})).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", {name: "Stop"}));
    expect(onStopSession).toHaveBeenCalledWith("session-1");
  });

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

  test("does not show Chat when capability or signed terminal access is absent", async () => {
    const {rerender} = renderDetail({name: "Shell", capabilities: {terminal: true, chat: false}});
    expect(screen.queryByRole("tab", {name: "Chat"})).not.toBeInTheDocument();

    rerender(
      <SessionDetail
        busy={false}
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

  test("renders server-reported marked runtime status and checkpoint time", async () => {
    renderDetail({
      agentUiVersion: "pi-web-ui-v1",
      agentRuntimeGeneration: 3,
      agentRuntimeLastCheckpointAt: "2026-08-29T12:00:00.000Z",
      agentRuntimeState: "running",
    });

    expect(await screen.findByRole("region", {name: "Agent runtime status"})).toHaveTextContent("Ready");
    expect(screen.getByText("Last successful checkpoint")).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    expect(screen.getByText("Runtime generation")).toBeInTheDocument();
  });

  test("keeps stop and persistence failures visible and blocks unsafe restart", () => {
    renderDetail({
      agentUiVersion: "pi-web-ui-v1",
      agentRuntimeState: "stopping",
      lastError: "checkpoint_storage_failed",
      status: "stop_failed",
    });

    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByRole("region", {name: "Agent runtime status"})).toHaveTextContent("checkpoint_storage_failed");
    expect(screen.getByRole("button", {name: "Restart"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "Restart"})).toHaveAttribute(
        "title",
        "Restart is disabled until the server confirms the stop outcome",
    );
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
