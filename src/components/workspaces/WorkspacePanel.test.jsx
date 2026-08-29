import {describe, expect, test} from "vitest";
import {resolveIsGithubWorkspace} from "./WorkspacePanel.jsx";

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
