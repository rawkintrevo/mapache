import {render, screen, within} from "@testing-library/react";
import {describe, expect, test, vi} from "vitest";
import {DrawerSessionList} from "../drawers/DrawerSessionList.jsx";
import {SessionList} from "./SessionList.jsx";
import {getSessionRunnerTags, getSessionStatusTone} from "./sessionPresentation.js";

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
});
