import {render, screen, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {DrawerSessionList} from "../drawers/DrawerSessionList.jsx";
import {SessionList} from "./SessionList.jsx";
import {getSessionResourceSummary, getSessionRunnerTags, getSessionStatusLabel, getSessionStatusTone, isRetryableProvisioningFailure} from "./sessionPresentation.js";

const baseSession = {
  id: "session-1",
  name: "Pi smoke",
  status: "running",
  imageKey: "pi-basic",
  resources: {
    cpu: "1",
    memory: "1Gi",
  },
};

describe("session presentation helpers", () => {
  test("maps known and unknown statuses to semantic tones", () => {
    expect(getSessionStatusTone("running")).toBe("success");
    expect(getSessionStatusTone("provisioning")).toBe("warning");
    expect(getSessionStatusTone("stop_failed")).toBe("danger");
    expect(getSessionStatusTone("stopped")).toBe("neutral");
    expect(getSessionStatusTone("future_status")).toBe("unknown");
    expect(getSessionStatusLabel({status: "provisioning", provisioningState: "queued"})).toBe("queued");
    expect(getSessionStatusTone("queued")).toBe("warning");
    expect(isRetryableProvisioningFailure({status: "provision_failed", provisioningRetryable: true})).toBe(true);
    expect(isRetryableProvisioningFailure({status: "provision_failed", provisioningRetryable: false})).toBe(false);
  });

  test("derives runner tags from normalized keys and legacy image values", () => {
    expect(getSessionRunnerTags({imageKey: "codex-web"})).toEqual(["codex", "web"]);
    expect(getSessionRunnerTags({imageKey: "default"})).toEqual(["default"]);
    expect(
        getSessionRunnerTags({
          image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-n64",
        }),
    ).toEqual(["pi", "n64"]);
  });

  test("summarizes preset, custom, and missing resources safely", () => {
    expect(getSessionResourceSummary({...baseSession, resources: {cpu: "1", memory: "2Gi"}})).toBe("Small · 1 vCPU / 2 GiB");
    expect(getSessionResourceSummary({...baseSession, resources: {cpu: "1", memory: "1Gi"}})).toBe("Custom · 1 vCPU / 1 GiB");
    expect(getSessionResourceSummary({...baseSession, resources: null})).toBe("Custom · — vCPU / —");
  });
});

describe("session row rendering", () => {
  test("renders status light tooltip and runner tags in the workspace session list", () => {
    render(
        <SessionList
          selectedSessionId=""
          selectedWorkspaceId="workspace-1"
          sessions={[{...baseSession, status: "provision_failed", imageKey: "codex-web", name: "Broken web"}]}
          onSelectSession={vi.fn()}
        />,
    );

    const row = screen.getByRole("button", {name: /Broken web/i});
    const statusLight = within(row).getByLabelText("Session status: provision_failed");
    expect(statusLight).toHaveAttribute("tabindex", "0");
    expect(statusLight).toHaveAttribute("aria-describedby");
    expect(within(row).getByText("provision_failed")).toHaveAttribute("role", "tooltip");
    expect(within(row).getByText("codex")).toBeInTheDocument();
    expect(within(row).getByText("web")).toBeInTheDocument();
  });

  test("renders the same accessory cluster in the drawer session list", () => {
    render(
        <DrawerSessionList
          state={{
            busy: false,
            selectedSessionId: "",
            selectedWorkspaceId: "workspace-1",
            sessions: [{...baseSession, imageKey: "default"}],
          }}
          onDeleteSession={vi.fn()}
          onSelectSession={vi.fn()}
          onStopSession={vi.fn()}
        />,
    );

    const row = screen.getByRole("button", {name: /^Pi smoke/i});
    expect(within(row).getByLabelText("Session status: running")).toBeInTheDocument();
    expect(within(row).getByText("default")).toBeInTheDocument();
  });

  test("shows retry action only for retryable provisioning failures", async () => {
    const onRetryProvisioningSession = vi.fn();
    const user = userEvent.setup();
    render(
        <DrawerSessionList
          state={{
            pendingOperations: {},
            selectedSessionId: "",
            selectedWorkspaceId: "workspace-1",
            sessions: [{...baseSession, status: "provision_failed", provisioningRetryable: true}],
          }}
          onDeleteSession={vi.fn()}
          onRetryProvisioningSession={onRetryProvisioningSession}
          onSelectSession={vi.fn()}
          onStopSession={vi.fn()}
        />,
    );

    await user.click(screen.getByRole("button", {name: "Retry provisioning for Pi smoke"}));
    expect(onRetryProvisioningSession).toHaveBeenCalledOnce();
    expect(onRetryProvisioningSession).toHaveBeenCalledWith("session-1");
  });
});
