import {render, screen, within} from "@testing-library/react";
import {describe, expect, test, vi} from "vitest";
import {DrawerSessionList} from "../drawers/DrawerSessionList.jsx";
import {SessionDetail} from "./SessionDetail.jsx";
import {SessionList} from "./SessionList.jsx";
import {
  getSessionImageFreshness,
  getSessionRunnerTags,
  getSessionStatusTone,
  isSessionRunningStaleImage,
} from "./sessionPresentation.js";

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

  test("maps image freshness states to labels and tooltips", () => {
    expect(getSessionImageFreshness({imageFreshness: {status: "latest"}})).toMatchObject({
      status: "latest",
      label: "Latest image",
      tone: "success",
      tooltip: "This session is running the latest runner image.",
    });
    expect(getSessionImageFreshness({imageFreshness: {status: "stale"}})).toMatchObject({
      status: "stale",
      label: "Stale image",
      tone: "warning",
    });
    expect(getSessionImageFreshness({})).toMatchObject({
      status: "unknown",
      label: "Image freshness unknown",
      tone: "neutral",
      tooltip: "Image freshness is not available for this session.",
    });
  });

  test("only treats running stale sessions as restart candidates", () => {
    expect(isSessionRunningStaleImage({status: "running", imageFreshness: {status: "stale"}})).toBe(true);
    expect(isSessionRunningStaleImage({status: "stopped", imageFreshness: {status: "stale"}})).toBe(false);
    expect(isSessionRunningStaleImage({status: "running", imageFreshness: {status: "latest"}})).toBe(false);
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
    expect(within(row).getByLabelText("Image freshness: Image freshness unknown")).toBeInTheDocument();
    expect(within(row).getByText("Image freshness is not available for this session.")).toHaveAttribute("role", "tooltip");
    expect(within(row).getByText("provision_failed")).toHaveAttribute("role", "tooltip");
    expect(within(row).getByText("codex")).toBeInTheDocument();
    expect(within(row).getByText("web")).toBeInTheDocument();
  });

  test("renders latest and stale freshness indicators independently from lifecycle status", () => {
    render(
        <SessionList
          selectedSessionId=""
          selectedWorkspaceId="workspace-1"
          sessions={[
            {...baseSession, name: "Latest", imageFreshness: {status: "latest"}},
            {...baseSession, id: "session-2", name: "Stale", imageFreshness: {status: "stale"}},
          ]}
          onSelectSession={vi.fn()}
        />,
    );

    const [latestRow, staleRow] = screen.getAllByRole("button");
    expect(within(latestRow).getByLabelText("Session status: running")).toBeInTheDocument();
    expect(within(latestRow).getByLabelText("Image freshness: Latest image")).toBeInTheDocument();
    expect(within(latestRow).getByText("This session is running the latest runner image.")).toBeInTheDocument();

    expect(within(staleRow).getByLabelText("Session status: running")).toBeInTheDocument();
    expect(within(staleRow).getByLabelText("Image freshness: Stale image")).toBeInTheDocument();
    expect(within(staleRow).getByText(/Restart the session to pick up the latest container/)).toBeInTheDocument();
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

  test("emphasizes restart when a running session has a stale image", () => {
    render(
        <SessionDetail
          busy={false}
          gitStatus={{}}
          isGithubWorkspace={false}
          session={{
            ...baseSession,
            serviceUrl: "https://session.example.run.app",
            capabilities: {terminal: true},
            imageFreshness: {status: "stale"},
          }}
          sshForwards={{}}
          workspaceId="workspace-1"
          onGetSessionAccessUrls={vi.fn().mockResolvedValue({terminalUrl: "https://session.example.run.app/terminal"})}
          onResizeSession={vi.fn()}
          onRestartSession={vi.fn()}
        />,
    );

    const restart = screen.getByRole("button", {name: "Restart this session to pick up the latest container image."});
    expect(restart).toHaveTextContent("Restart for latest image");
    expect(restart).toHaveClass("session-restart-stale");
    expect(restart).toHaveAttribute("title", "Restart this session to pick up the latest container image.");
  });
});
