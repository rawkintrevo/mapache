import {describe, expect, test} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {WorkspacePanel, resolveIsGithubWorkspace} from "./WorkspacePanel.jsx";

test("shows a Start failure beside an existing stopped session", () => {
  const html = renderToStaticMarkup(<WorkspacePanel
    selectedSession={{id: "session-1", status: "stopped"}}
    selectedWorkspace={{id: "workspace-1"}}
    state={{selectedWorkspaceId: "workspace-1", error: "Could not start workspace"}}
  />);
  expect(html).toContain('role="alert"');
  expect(html).toContain("Could not start workspace");
});

describe("resolveIsGithubWorkspace", () => {
  test("uses explicit blank workspace metadata over stale session metadata", () => {
    expect(resolveIsGithubWorkspace(
        {source: {type: "blank"}},
        {sourceType: "github"},
    )).toBe(false);
  });

  test("falls back to session metadata for legacy workspaces", () => {
    expect(resolveIsGithubWorkspace({}, {sourceType: "github"})).toBe(true);
  });
});
