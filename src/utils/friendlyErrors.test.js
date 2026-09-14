import {describe, expect, it} from "vitest";
import {friendlyMcpConfigError, friendlyWorkspaceError} from "./friendlyErrors.js";

describe("friendly retained API errors", () => {
  it("maps workspace source validation errors", () => {
    expect(friendlyWorkspaceError(new Error("invalid_github_repo_url")))
        .toBe("Enter a valid GitHub repository URL, for example https://github.com/owner/repo.");
  });

  it("maps MCP transport validation errors", () => {
    expect(friendlyMcpConfigError(new Error("multiple_mcp_server_transports")))
        .toBe("Choose command or URL, not both.");
  });
});
