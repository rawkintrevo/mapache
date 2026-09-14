import {render, screen, within} from "@testing-library/react";
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
  const accessUrls = options.accessUrls || {
    terminalUrl: "https://runner.example/?mapache_access=terminal-token",
    browserUrl: "https://runner.example/browser/?mapache_access=browser-token",
    agentUrl: "https://runner.example/agent/?mapache_access=agent-token",
  };
  return render(
      <SessionDetail
        access={{accessUrls, error: "", refresh: vi.fn(), refreshAfterConnectionFailure: vi.fn()}}
        busy={options.busy || false}
        isGithubWorkspace={false}
        metrics={{sample: null, connectionState: "connecting"}}
        session={currentSession}
        workspaceId="workspace-1"
        onGetSessionAccessUrls={vi.fn().mockResolvedValue(accessUrls)}
        onResizeSession={vi.fn()}
        onRetryProvisioningSession={options.onRetryProvisioningSession}
        onSetSessionLongRunning={options.onSetSessionLongRunning}
        onRestartSession={options.onRestartSession || vi.fn()}
        onStopSession={options.onStopSession}
      />,
  );
}

describe("SessionDetail Chrome workflow", () => {
  test("makes the embedded Agent the default managed workspace surface", async () => {
    renderDetail({
      agentUiVersion: "pi-web-ui-v1",
      harnessId: "pi",
      capabilities: {terminal: true, preview: true, chrome: true},
    });

    expect(await screen.findByTitle("Agent Chrome smoke")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", {name: "Workspace surfaces"})).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", {name: "Preview"})).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", {name: "Terminal"})).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", {name: "Chat"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Models"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Goal"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Shell"})).not.toBeInTheDocument();

    expect(screen.queryByRole("button", {name: "Stop"})).not.toBeInTheDocument();
  });

  test("does not render resource meters in the canvas-specific detail", () => {
    renderDetail();
    expect(screen.queryByLabelText("Resource utilization")).not.toBeInTheDocument();
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
        access={{accessUrls: {}, error: "", refresh: vi.fn(), refreshAfterConnectionFailure: vi.fn()}}
        busy={false}
        isGithubWorkspace={false}
        metrics={{sample: null, connectionState: "idle"}}
        session={session({name: "Pi without access", harnessId: "pi", capabilities: {terminal: true, chat: true}})}
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

  test("directs provisioning failures to the workspace lifecycle control", () => {
    renderDetail(
        {status: "provision_failed", provisioningRetryable: true, serviceUrl: null},
        {busy: false},
    );

    expect(screen.getByText("Use Play in the navigation bar to restart the workspace runtime.")).toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Retry provisioning"})).not.toBeInTheDocument();
  });

  test("does not expose restart controls inside session detail", () => {
    renderDetail(
        {status: "provision_failed", provisioningRetryable: false, serviceUrl: null},
        {},
    );
    expect(screen.queryByRole("button", {name: "Retry provisioning"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Restart"})).not.toBeInTheDocument();
  });

  test("does not expose retry while another operation is pending", () => {
    renderDetail(
        {status: "provision_failed", provisioningRetryable: true, serviceUrl: null},
        {busy: true, onRetryProvisioningSession: vi.fn()},
    );
    expect(screen.queryByRole("button", {name: "Retry provisioning"})).not.toBeInTheDocument();
  });

  test("shows stale image guidance without an in-content restart button", () => {
    renderDetail({runnerImageFreshness: "stale"});
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

    expect(await screen.findByTitle("Agent Chrome smoke")).toBeInTheDocument();
    expect(screen.queryByRole("region", {name: "Agent runtime status"})).not.toBeInTheDocument();
  });

  test("keeps stop and persistence failures visible and blocks unsafe restart", () => {
    renderDetail({
      agentUiVersion: "pi-web-ui-v1",
      agentRuntimeState: "stopping",
      lastError: "checkpoint_storage_failed",
      status: "stop_failed",
    });

    expect(screen.getByTitle("Agent Chrome smoke")).toBeInTheDocument();
    expect(screen.queryByText("checkpoint_storage_failed")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", {name: "Agent runtime status"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Restart"})).not.toBeInTheDocument();
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

test("shows the persisted automatic pause policy and updates Long-running", async () => {
  const user = userEvent.setup();
  const onSetSessionLongRunning = vi.fn();
  renderDetail({
    agentUiVersion: "pi-web-ui-v1",
    idleTimeoutMinutes: 60,
    longRunning: false,
  }, {onSetSessionLongRunning});

  const policy = await screen.findByRole("region", {name: "Automatic pause policy"});
  expect(policy).toHaveTextContent("Automatically pauses after 60 minutes without activity.");
  const toggle = within(policy).getByRole("checkbox", {name: "Long-running"});
  expect(toggle).not.toBeChecked();
  await user.click(toggle);
  expect(onSetSessionLongRunning).toHaveBeenCalledWith("session-1", true);
});

test("communicates that Long-running bypasses automatic pause", () => {
  renderDetail({
    agentUiVersion: "pi-web-ui-v1",
    idleTimeoutMinutes: 60,
    longRunning: true,
  });

  const policy = screen.getByRole("region", {name: "Automatic pause policy"});
  expect(policy).toHaveTextContent("Automatic pause is disabled");
  expect(policy).toHaveTextContent("Manual Pause remains available in either state.");
  expect(screen.getByRole("checkbox", {name: "Long-running"})).toBeChecked();
});

test("shows resize progress on the managed agent surface", () => {
  renderDetail({agentUiVersion: "pi-web-ui-v1", resizeOperationState: "queued", serviceUrl: null});
  expect(screen.getByRole("status")).toHaveTextContent("Resizing runtime");
});

test("shows asynchronous resize failure on the managed agent surface", () => {
  renderDetail({agentUiVersion: "pi-web-ui-v1", resizeOperationState: "failed", resizeOperationError: "session_stop_failed", serviceUrl: null});
  expect(screen.getByRole("alert")).toHaveTextContent("session_stop_failed");
});
