import {describe, expect, it} from "vitest";
import {getWorkspaceTag, workspaceSourceSummary} from "./workspaceSourceSummary.js";

describe("getWorkspaceTag", () => {
  it("labels blank workspaces", () => {
    expect(getWorkspaceTag({source: {type: "blank"}})).toBe("Blank");
    expect(getWorkspaceTag({})).toBe("Blank");
    expect(getWorkspaceTag(null)).toBe("Blank");
  });

  it("labels GitHub workspaces", () => {
    expect(getWorkspaceTag({source: {type: "github"}})).toBe("GitHub");
  });

  it("labels SSH-backed dev-machine workspaces", () => {
    expect(getWorkspaceTag({source: {type: "ssh"}})).toBe("Dev machine");
  });
});

describe("workspaceSourceSummary", () => {
  it("does not expose blank workspace storage prefixes in the primary summary", () => {
    expect(workspaceSourceSummary({source: {type: "blank"}, storagePrefix: "workspaces/user/session-id"})).toBe("");
  });

  it("does not expose SSH workspace storage prefixes in the primary summary", () => {
    expect(workspaceSourceSummary({source: {type: "ssh"}, storagePrefix: "workspaces/user/session-id"})).toBe("");
  });

  it("summarizes GitHub source metadata", () => {
    expect(workspaceSourceSummary({
      source: {
        type: "github",
        owner: "rawkintrevo",
        repo: "mapache",
        resolvedBranch: "main",
        resolvedCommit: "abcdef1234567890",
      },
    })).toBe("rawkintrevo/mapache · main · abcdef1");
  });
});
