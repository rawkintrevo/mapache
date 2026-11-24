import {render, screen} from "@testing-library/react";
import {describe, expect, test} from "vitest";
import {RunDetailsPanel} from "./RunDetailsPanel.jsx";

function createRun(workspaceOutput) {
  return {
    id: "run-1",
    automationName: "Nightly notes",
    status: "succeeded",
    workspaceOutput,
  };
}

describe("RunDetailsPanel", () => {
  test("identifies retained VM output when no external URI is available", () => {
    render(<RunDetailsPanel run={createRun({path: "/automations/nightly-notes"})} />);

    expect(screen.getByText("Retained on the workspace VM.")).toBeInTheDocument();
    expect(screen.queryByText("gs://bucket/output")).not.toBeInTheDocument();
  });

  test("shows the external output URI when one is available", () => {
    render(<RunDetailsPanel run={createRun({path: "/automations/nightly-notes", storageUri: "gs://bucket/output"})} />);

    expect(screen.getByText("gs://bucket/output")).toBeInTheDocument();
    expect(screen.queryByText("Retained on the workspace VM.")).not.toBeInTheDocument();
  });
});
