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

  test("emphasizes restart when the running image is stale", () => {
    renderDetail({runnerImageFreshness: "stale"});
    const restart = screen.getByRole("button", {name: "Restart session to pick up the latest container image"});
    expect(restart).toHaveClass("session-restart-button--stale");
    expect(restart).toHaveAttribute("title", "Restart to pick up the latest container image");
    expect(screen.getByText("Stale image")).toBeInTheDocument();
    expect(screen.getByText(/older runner image/)).toBeInTheDocument();
  });
});
