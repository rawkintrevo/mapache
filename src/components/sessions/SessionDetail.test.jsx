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
  return render(
      <SessionDetail
        busy={options.busy || false}
        gitStatus={null}
        isGithubWorkspace={false}
        session={session(overrides)}
        sshForwards={{}}
        workspaceId="workspace-1"
        onGetSessionAccessUrls={vi.fn().mockResolvedValue({
          terminalUrl: "https://runner.example/?mapache_access=terminal-token",
          browserUrl: "https://runner.example/browser/?mapache_access=browser-token",
        })}
        onResizeSession={vi.fn()}
        onRetryProvisioningSession={options.onRetryProvisioningSession}
        onRestartSession={options.onRestartSession || vi.fn()}
      />,
  );
}

describe("SessionDetail Chrome workflow", () => {
  test("shows the Chrome canvas only for Chrome-capable sessions", async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole("tab", {name: "Chrome"}));
    expect(await screen.findByTitle("Chrome Chrome smoke")).toHaveAttribute(
        "src",
        "https://runner.example/browser/?mapache_access=browser-token",
    );
  });

  test("does not add a Chrome canvas to a normal terminal session", () => {
    renderDetail({
      name: "Pi smoke",
      capabilities: {terminal: true, preview: false, chrome: false},
    });

    expect(screen.queryByRole("tab", {name: "Chrome"})).not.toBeInTheDocument();
  });

  test("submits the selected preset only when Resize is clicked", async () => {
    const user = userEvent.setup();
    const onResizeSession = vi.fn();
    render(
        <SessionDetail
          busy={false}
          gitStatus={null}
          isGithubWorkspace={false}
          session={session({resources: {cpu: "1", memory: "2Gi"}})}
          sshForwards={{}}
          workspaceId="workspace-1"
          onGetSessionAccessUrls={vi.fn().mockResolvedValue({terminalUrl: "https://runner.example/"})}
          onResizeSession={onResizeSession}
          onRestartSession={vi.fn()}
        />,
    );

    await user.click(screen.getByRole("radio", {name: /Medium/}));
    expect(onResizeSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", {name: "Resize"}));
    expect(onResizeSession).toHaveBeenCalledWith("session-1", {cpu: "2", memory: "4Gi"});
  });

  test("renders older resource pairs as Custom without rewriting them", () => {
    renderDetail({resources: {cpu: "1", memory: "1Gi"}});
    expect(screen.getByText(/Custom selection/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", {name: "CPU"})).toHaveValue("1");
    expect(screen.getByRole("combobox", {name: "Memory"})).toHaveValue("1Gi");
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

  test("does not show retry for non-retryable failures", () => {
    renderDetail({status: "provision_failed", provisioningRetryable: false, serviceUrl: null});
    expect(screen.queryByRole("button", {name: "Retry provisioning"})).not.toBeInTheDocument();
  });

  test("disables retry while another operation is pending", () => {
    renderDetail(
        {status: "provision_failed", provisioningRetryable: true, serviceUrl: null},
        {busy: true, onRetryProvisioningSession: vi.fn()},
    );
    expect(screen.getByRole("button", {name: "Retry provisioning"})).toBeDisabled();
  });
});
