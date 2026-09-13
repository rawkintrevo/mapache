import {render, screen, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {DrawerSessionList} from "../drawers/DrawerSessionList.jsx";
import {SessionList} from "./SessionList.jsx";
import {formatSessionCheckpointTime, getSessionImageFreshness, getSessionResourceSummary, getSessionRunnerTags, getSessionRuntimeError, getSessionRuntimeStatus, getSessionStatusLabel, getSessionStatusTone, isRetryableProvisioningFailure, isRuntimeStopUncertain} from "./sessionPresentation.js";

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
    expect(getSessionImageFreshness({status: "running", runnerImageFreshness: "latest"})).toMatchObject({
      state: "latest",
      label: "Latest image",
      tone: "success",
    });
    expect(getSessionImageFreshness({status: "running", runnerImageFreshness: "stale"})).toMatchObject({
      state: "stale",
      label: "Stale image",
      tone: "warning",
    });
    expect(getSessionImageFreshness({status: "stopped", runnerImageFreshness: "latest"})).toMatchObject({
      state: "unknown",
      label: "Unknown",
      tone: "neutral",
    });
  });

  test("derives runner tags from normalized keys and legacy image values", () => {
    expect(getSessionRunnerTags({imageKey: "pi-chrome"})).toEqual(["pi", "chrome"]);
    expect(getSessionRunnerTags({imageKey: "default"})).toEqual(["default"]);
    expect(
        getSessionRunnerTags({
          image: "us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome",
        }),
    ).toEqual(["pi", "chrome"]);
  });

  test("summarizes preset, custom, and missing resources safely", () => {
    expect(getSessionResourceSummary({...baseSession, resources: {cpu: "1", memory: "2Gi"}})).toBe("Small · 1 vCPU / 2 GiB");
    expect(getSessionResourceSummary({...baseSession, resources: {cpu: "1", memory: "1Gi"}})).toBe("Custom · 1 vCPU / 1 GiB");
    expect(getSessionResourceSummary({...baseSession, resources: null})).toBe("Custom · — vCPU / —");
  });

  test("maps marked runtime lifecycle and persistence state to user-facing status", () => {
    expect(getSessionRuntimeStatus({status: "provisioning", agentRuntimeState: "starting"})).toMatchObject({
      state: "starting",
      label: "Starting",
    });
    expect(getSessionRuntimeStatus({status: "running", agentRuntimeState: "running"})).toMatchObject({
      state: "ready",
      label: "Ready",
    });
    expect(getSessionRuntimeStatus({status: "stopping", agentRuntimeState: "stopping"})).toMatchObject({
      state: "stopping",
      label: "Stopping",
    });
    expect(getSessionRuntimeStatus({status: "stopped", agentRuntimeState: "stopped"})).toMatchObject({
      state: "stopped",
      label: "Stopped",
    });
    expect(getSessionRuntimeStatus({status: "running", agentRuntimeState: "running", agentRuntimeCheckpointError: "checkpoint_storage_failed"})).toMatchObject({
      state: "error",
      label: "Error",
    });
    expect(getSessionRuntimeError({agentRuntimeRecoveryWarning: "interrupted"})).toBe("runtime_interrupted_checkpoint_recovery_required");
    expect(isRuntimeStopUncertain({status: "delete_failed"})).toBe(true);
    expect(isRuntimeStopUncertain({status: "stop_failed", agentRuntimeState: "stopping"})).toBe(false);
    expect(isRuntimeStopUncertain({status: "running", agentRuntimeState: "running"})).toBe(false);
    expect(formatSessionCheckpointTime("not-a-timestamp")).toBe("Not recorded");
  });
});

describe("session row rendering", () => {
  test("renders status light tooltip and runner tags in the workspace session list", () => {
    render(
        <SessionList
          selectedSessionId=""
          selectedWorkspaceId="workspace-1"
          sessions={[{...baseSession, status: "provision_failed", imageKey: "pi-chrome", name: "Broken web"}]}
          onSelectSession={vi.fn()}
        />,
    );

    const row = screen.getByRole("button", {name: /Broken web/i});
    const statusLight = within(row).getByLabelText("Session status: provision_failed");
    expect(statusLight).toHaveAttribute("tabindex", "0");
    expect(statusLight).toHaveAttribute("aria-describedby");
    expect(within(row).getByText("provision_failed")).toHaveAttribute("role", "tooltip");
    expect(within(row).getByText("pi")).toBeInTheDocument();
    expect(within(row).getByText("chrome")).toBeInTheDocument();
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

  test("pauses running sessions and resumes stopped sessions from the drawer", async () => {
    const onRestartSession = vi.fn();
    const onStopSession = vi.fn();
    const user = userEvent.setup();
    const {rerender} = render(
        <DrawerSessionList
          state={{
            pendingOperations: {},
            selectedSessionId: "",
            selectedWorkspaceId: "workspace-1",
            sessions: [baseSession],
          }}
          onDeleteSession={vi.fn()}
          onRestartSession={onRestartSession}
          onSelectSession={vi.fn()}
          onStopSession={onStopSession}
        />,
    );

    await user.click(screen.getByRole("button", {name: "Pause Pi smoke"}));
    expect(onStopSession).toHaveBeenCalledWith("session-1");

    rerender(
        <DrawerSessionList
          state={{
            pendingOperations: {},
            selectedSessionId: "",
            selectedWorkspaceId: "workspace-1",
            sessions: [{...baseSession, agentRuntimeState: "stopping", status: "stopped"}],
          }}
          onDeleteSession={vi.fn()}
          onRestartSession={onRestartSession}
          onSelectSession={vi.fn()}
          onStopSession={onStopSession}
        />,
    );

    expect(screen.getByRole("button", {name: "Resume Pi smoke"})).toBeDisabled();

    rerender(
      <DrawerSessionList
        state={{
          pendingOperations: {},
          selectedSessionId: "",
          selectedWorkspaceId: "workspace-1",
          sessions: [{...baseSession, agentRuntimeState: "stopped", status: "stopped"}],
        }}
        onDeleteSession={vi.fn()}
        onRestartSession={onRestartSession}
        onSelectSession={vi.fn()}
        onStopSession={onStopSession}
      />,
    );

    await user.click(screen.getByRole("button", {name: "Resume Pi smoke"}));
    expect(onRestartSession).toHaveBeenCalledWith("session-1");
  });
});
